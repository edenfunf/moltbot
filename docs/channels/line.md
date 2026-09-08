---
summary: "LINE Messaging API plugin setup, config, and usage"
read_when:
  - You want to connect OpenClaw to LINE
  - You need LINE webhook + credential setup
  - You want LINE-specific message options
title: LINE
---

LINE connects to OpenClaw via the LINE Messaging API. The plugin runs as a webhook
receiver on the Gateway and uses your channel access token + channel secret for
authentication.

Status: official plugin, installed separately. Direct messages, group chats, media,
locations, Flex messages, template messages, and quick replies are supported.
Reactions and threads are not supported.

## Install

Install LINE before configuring the channel:

```bash
openclaw plugins install @openclaw/line
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/line-plugin
```

## Setup

1. Create a LINE Developers account and open the Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Create (or pick) a Provider and add a **Messaging API** channel.
3. Copy the **Channel access token** and **Channel secret** from the channel settings.
4. Enable **Use webhook** in the Messaging API settings.
5. Set the webhook URL to your gateway endpoint (HTTPS required):

```text
https://gateway-host/line/webhook
```

The Gateway answers LINE's signed webhook verification request: a `POST` with an
empty `events` list. Signed events in LINE's `standby` mode are acknowledged without
queueing or replying, because another channel holds chat control. Other signed
inbound events enter the durable ingress queue before `200`; agent processing
continues asynchronously.
Failed delivery is retried from the queue, including after a Gateway restart, and
poison events become failed queue records after bounded retries. If durable
persistence fails, the request returns
`500` instead of acknowledging an event that could be lost.
Delivery is at least once across the queue-to-agent boundary: a Gateway shutdown or
crash during an active delivery can replay the turn. Message events deduplicate by
LINE message ID; other event types use `webhookEventId`. Retained completion records
suppress ordinary duplicate webhooks, but handlers that perform external side effects
should still be idempotent.
If you need a custom path, set `channels.line.webhookPath` or
`channels.line.accounts.<id>.webhookPath` and update the URL accordingly.

Security notes:

- LINE signature verification is body-dependent (HMAC over the raw body), so OpenClaw applies a strict pre-auth body limit (64 KB) and read timeout before verification.
- OpenClaw processes webhook events from the verified raw request bytes. Upstream middleware-transformed `req.body` values are ignored for signature-integrity safety.

## Inbound durability

The [Setup](#setup) webhook contract acknowledges an event only after it is durably
queued. The durable `200` carries `x-openclaw-delivery-accepted: durable`; signed
verification pings (empty event lists), standby-only batches, and error responses
omit the marker, so
reverse proxies can require it to distinguish durable acceptance from a generic
`200`. From there, delivery runs through the core channel-ingress drain with
LINE-specific settings:

- **Per-conversation ordering.** Events are serialized by source lane —
  `group:<groupId>`, `room:<roomId>`, or `user:<userId>`; events without a
  conversation source use their own event-scoped lane. Within a lane, events
  dispatch in received order, so a retrying event delays later events in the same
  chat. One chat's backlog never blocks another chat's lane, but all lanes share
  a cap of 8 concurrent deliveries: other chats progress independently while a
  slot is free, and a 9th lane waits for one to open.
- **Retries.** A failed delivery retries with exponential backoff starting at
  1 second and doubling per attempt, roughly two minutes of cumulative backoff
  across the window. After the 8th failed attempt the event dead-letters
  (`retry-limit-exceeded`) immediately: LINE opts out of the generic 24-hour
  dead-letter age floor so a poison event cannot block its conversation lane for
  a day.
- **Non-retryable failures.** These dead-letter immediately, with no further
  retries regardless of the attempt count: stored payloads that no longer parse
  (`invalid-event`), deliveries that already committed side effects
  (`delivery-side-effects-committed`), and LINE API authentication failures
  (`authentication-failed`, HTTP 401/403).
- **Stall watchdog.** A claimed delivery that neither reaches agent-turn adoption
  nor reports continued deferred progress for 5 minutes is aborted and released
  back to its lane through the same retry policy as any other failure: the event
  returns to pending with its attempt count incremented and `handler-timeout`
  recorded as its last error, and it keeps its place at the head of its lane. A
  stall is not itself a dead letter — only the retry limit above ends the event,
  as `retry-limit-exceeded`. The watchdog only covers the window between claim
  and adoption: deferred progress re-arms it and adoption clears it, so a long
  agent turn is never interrupted by it. Adoption that arrives after the
  watchdog fires is fenced off, so a late turn cannot claim an event that has
  already been handed back.
- **Crash recovery.** Every drain pass opens with a recovery sweep that reclaims
  any claim whose owning Gateway process is no longer running, so a delivery lost
  to a hard crash is retried on the next sweep rather than after a timeout. The
  30-minute claim lease is the fallback bound for the opposite case: without a
  successful lease refresh, it caps how long a claim stays protected solely
  because its owner PID still looks alive — including a reused PID whose process
  identity cannot be verified. Events accepted while the Gateway is stopping are
  still persisted and drain after the next start.
- **Duplicate suppression window.** On every admission, LINE removes completed
  and failed queue records older than 30 days, then keeps the most recently
  updated 4096 records of each kind per account. Because pruning runs before the
  new event is queued rather than on a timer, records can remain past 30 days on
  an idle account, and a newly completed record can put the count above 4096 until
  the next admission. While a record exists, a redelivered webhook for the same
  event is acknowledged without a second dispatch; once it is gone — by age or by
  cap — a redelivery is admitted and dispatched again, so handlers with external
  side effects should not treat this window as a substitute for their own
  idempotency.

The `500`-on-persistence-failure contract only helps if LINE re-sends the event.
LINE redelivers a webhook when **Webhook redelivery** is enabled for the channel in
the LINE Developers Console (Messaging API settings, alongside **Use webhook**) and
the bot server did not answer `2xx`. Without that setting, an event refused with
`500` is not re-sent. Even enabled, redelivery is best effort rather than a
guarantee: LINE documents that it is not reliable, that the retry count and
interval are undisclosed, and that redelivered events may arrive out of order or
more than once (the duplicate suppression window above absorbs the repeats). See
[Redeliver a webhook that failed to be received](https://developers.line.biz/en/docs/messaging-api/receiving-messages/#webhook-redelivery).

Dead-lettered events stay inspectable and, depending on the failure reason,
recoverable; see [Inbound dead letters](/cli/channels#inbound-dead-letters) and
[Troubleshooting](#troubleshooting) below.

## Outbound durability

Some LINE sends are recorded before they go out so an interrupted one can be
resolved instead of guessed at. This section says which sends those are, what the
messages mean when recovery declines, and what it costs when the record itself
cannot be written.

### When a send could not be reconciled

Some LINE sends are recorded before they go out. A reply is split into parts, and each
part writes down every push it will make before the first of them leaves, so a send
interrupted inside a part can be recovered by reissuing the recorded requests under the
same retry keys
— a push LINE already took answers 409 with its original receipt, and one that never
landed goes out now. This runs on any retry of the same queued send, not only after a
restart, and the record always wins over what the reply would render today.

Not every send is recorded. On the inbound side the recorded set is narrow: a turn's
reply is recorded only when it is a final block, carries text without media or
LINE-specific rich content, does not reply to one specific earlier message (LINE cannot
quote by message id), and the event's reply token is spent or absent — so the first
reply of an exchange, which is often the only one, is normally sent inline and not
recorded.

Sends queued by other callers follow the same capability rule. Anything the Gateway
queues as a single prepared payload — `openclaw message send`, the agent's `message`
tool, a cron delivery, the `ask_user` question prompt — is recorded **unless it asks for
something this channel cannot do**: a reply-to, a thread, or a silent send. LINE
declares none of those three, so a send carrying one gets no durable record, exactly as
if it had not been queued.

One class is excluded for a different reason, and it is not a misconfiguration. A
Gateway conversation send — what the Control UI's chat and the `conversations` methods
use — asks for queue persistence, and core reads that as "this caller settles its own
delivery" and turns reconciliation off for it outright, whatever the channel supports.
Those sends are queued and durable; they are simply not reconciled here.

A send with no inbound LINE event behind it leaves nothing in
`openclaw channels dead-letters list` when it fails. Where it does show up depends on
the caller: most only log. A failed `ask_user` prompt cancels the question either way,
and the agent is told so — as a tool error when the prompt never became visible, and as
a result saying the controls failed to deliver when it did. A failed exec-approval
prompt leaves a command waiting for an approval that was never asked for.

The observable rule is simple: a send that was never recorded reports
`LINE delivery carried no durable record, so a replay could not be deduplicated` when
it needs reconciling. Seeing that message is how you know this send was not on the
recorded path; it is not itself a fault.

When recovery cannot run safely it stops instead of guessing, and `openclaw logs`
carries the reason. **Read these as "delivery unknown", not "not delivered"** — they
fire exactly when OpenClaw cannot tell whether LINE took the send, and it settles them
as `unknown` rather than `failed` for that reason. Check the conversation before
re-sending anything by hand; a blind resend is how the recipient gets two copies.
These particular outcomes do not dead-letter the incoming event, so
`openclaw channels dead-letters resubmit` is the wrong tool for them.

- **`LINE retry key expired before the queued send could be reconciled`:** LINE forgets
  a retry key 24 hours after the send was first handed to it, so a replay after that
  window could no longer be deduplicated. Expect this only after an outage longer than
  a day — sooner means the host clock moved.
- **`LINE delivery carried no durable record, so a replay could not be deduplicated`:**
  as above — this send was not on the recorded path, so its pushes used keys LINE will
  not deduplicate. It is ordinary for the reply shapes listed above, and it is also the
  only signal that a send you expected to be recorded was not: OpenClaw falls back to
  the unrecorded path without logging that it did. To tell the two apart, check the
  send against the conditions listed above — a reply carrying media, LINE rich content
  or an explicit reply-to is expected here, and so is the first reply of an exchange,
  which still holds its reply token. A plain-text reply that meets none of those and
  still reports this is a defect worth reporting rather than a setting to change:
  nothing in the configuration turns recording on or off.
- **`LINE ambiguous delivery is missing recorded parts: ...`:** a long reply, or one
  carrying several media files, is split into parts, and each part writes its record
  before its first push leaves. A part with no record therefore never reached LINE,
  while at least one other part got as far as starting to send. Reconciliation answers
  for the whole queued send, and neither "sent" nor "not sent" is true of a delivery in
  that state, so it refuses rather than resend parts the recipient may already have. The
  named indexes are the parts with no record.
- **Other `LINE durable send plan ...` messages** (`is invalid`, `is invalid JSON`,
  `key is invalid`, `part topology is inconsistent`, `requires a queue id`,
  `disappeared during reconciliation`) mean the stored evidence is not trustworthy
  enough to replay from, so recovery declines rather than risk duplicating an accepted
  push or dropping one LINE never received.

None of the outcomes named above is retried: each settles the delivery as unresolved and
not retryable, so nothing will arrive later — read what did reach the conversation, then
send the rest by hand. A failure to _read_ the record back is the one exception. That is
the storage layer failing rather than the record being untrustworthy, its message is the
store's own, and it stays retryable, so a transient state-directory problem resolves on
a later attempt instead of stranding the delivery.

A refusal LINE itself returns while a replay is in flight is not on this list: it is
surfaced verbatim, so the reason reads as LINE wrote it rather than as one of the
messages above.

#### When the record itself cannot be written

Two things can fail before a send is recorded, and they end differently.

If the **queue row** cannot be written, what happens depends on how the caller asked
for the send. A LINE agent reply is best-effort, so it still goes out live and
`openclaw logs` carries `outbound queue write failed; continuing without durability`.
That send has no queue row, so nothing will ever replay it and nothing can reconcile
it: if it is interrupted, it is simply lost. Callers that ask for a durable send
outright — the `ask_user` prompt and the exec-approval prompt among them — get no such
fallback and no such log line. Their send fails instead.

If the **recorded plan** cannot be stored, that part of the send fails. When the send
was answering an inbound message it is not silent about it: the turn has been adopted by
the time it replies, so the LINE event that prompted it is dead-lettered rather than
answered, under the reason `delivery-side-effects-committed`. As noted earlier on this page, that reason must never
be resubmitted — the turn was already adopted, so re-enqueuing repeats the committed
work. Fix the cause and let the sender ask again. A send with no inbound event behind it
— a cron delivery, `openclaw message send`, an `ask_user` prompt — has nothing to
dead-letter, so it fails wherever its own caller reports failures and leaves no queued
record to find. What you see depends on which half of the store rejected it: a validation
problem is reported as `LINE durable send plan part N cannot be recorded: ...`, while
the plan store's own refusals surface unchanged and mention neither LINE nor the part —
`Plugin blob namespace reached its stored row limit.` or `... stored byte limit.` when
the plan namespace is full, `plugin blob entry exceeds the configured 1048576 byte
limit` when this one part's record is itself too large, and other store errors when the
state directory will not take the write.

Four more come from the moment a part claims its record, and they name a conflict
rather than a storage fault. `LINE durable send plan part N was recorded for a different
recipient`, `... for a different fan-out` and `... for a different account` mean a record
already exists under this delivery's key but does not describe this send. The account one
is the dimension that decides deduplication: LINE remembers a retry key per channel, so a
record claimed under one account says nothing about what another account's channel took. The fan-out one is the reachable one:
if the reply now splits into a different number of parts than the attempt that recorded
it — an upgrade between attempts that changes how a reply is split — the claim is
refused. Each retry of that queued send renders the reply again from the same payload,
so it produces the same new shape and is refused the same way, and the reply does not
go out. Send it again as a new message rather than waiting. `... disappeared while being recorded` means the record
was claimed and then vanished before it could be read back; nothing was sent. One more,
`LINE durable send plan part index must be a non-negative integer`, means a send reached
the recorder without the part coordinates its route is supposed to carry; nothing is sent
under a topology that was guessed at.

**A refused record does not always mean nothing was sent.** A reply is split into
parts — one per text chunk, one per media file — and each part records itself just
before its own pushes leave. Within one part that ordering is airtight: the record
lands first, so a part whose record is refused sends nothing. Across parts it is not.
If the store fills between part 2 and part 3, parts 1 and 2 are already on the
recipient's phone and the rest never arrives. The turn fails and dead-letters, and
because that dead letter must not be resubmitted, nothing retries it. The recipient
keeps a truncated reply with no notice that it was cut off. Read a namespace-limit
message as "some of this reply may already have been delivered" and check the
conversation before doing anything by hand.

The namespace limits clear as sends settle; the per-entry limit does not — a part whose
record cannot fit will never fit, so that part is permanently undeliverable. It is
worth knowing which replies can get there. A text reply is chunked into parts of at
most the channel's message length, so each of its records stays small. A reply carrying
structured content — a card, quick replies, a location — is handed to the channel whole
as a single part, and every push it fans out into is recorded together, so that is the
shape whose record can grow. No setting splits it: the chunk limit only plans parts for
the text path, and LINE does not expose it as a setting anyway.

One more consequence worth knowing before it bites. The plan namespace refuses new
entries when full rather than evicting, with records kept about an hour past their
twenty-four-hour window and cleared only as each send settles. The namespace is shared
by the whole LINE plugin, not divided per account: one that fills up stops recorded
replies for **every** LINE account on this Gateway until it drains, and there is no CLI
or doctor command to inspect or clear it. Watch for the limit messages above; they are
the only warning, and they arrive after replies have already started failing.

## Configure

Minimal config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Public DM config:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

Env vars (default account only):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Token/secret files:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

`tokenFile` and `secretFile` must point to regular files. Symlinks are rejected.
Inline config values win over files; env vars are the last fallback for the default account.

Multiple accounts:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

Direct messages default to pairing. Unknown senders get a pairing code and their
messages are ignored until approved:

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Allowlists and policies:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled` (default `pairing`)
- `channels.line.allowFrom`: allowlisted LINE user IDs for DMs; `dmPolicy: "open"` requires `["*"]`
- `channels.line.groupPolicy`: `allowlist | open | disabled` (default `allowlist`)
- `channels.line.groupAllowFrom`: allowlisted LINE user IDs for groups; DM `allowFrom` entries do not admit group senders
- Per-group overrides: `channels.line.groups.<groupId>.allowFrom` (plus `enabled`, `requireMention`, `systemPrompt`, `skills`). With
  `groupPolicy: "allowlist"`, set `groupAllowFrom` or the per-group `allowFrom`; an empty group allowlist blocks group messages even when DMs are open.
- `channels.line.groups."*"` is the defaults entry for every group and room, not a fallback that a named entry replaces. A named entry overrides `"*"` field by field, so each field the named entry omits is taken from `"*"`. This matches how `requireMention` already resolves through the shared group scope tree; see [Groups](/channels/groups).
- Upgrade check: if you set `enabled` or `allowFrom` only on `channels.line.groups."*"` while also listing a named group or room, those wildcard values now apply to that named entry as well. Earlier releases returned the named entry alone, so wildcard-only fields never reached it. Before upgrading, review any `"*"` entry that sets `enabled: false` or narrows `allowFrom`, and repeat the value on a named entry that should keep its current access.
- Quoting one of the bot's own messages counts as addressing it, so a group reply made with LINE's quote gesture reaches the agent without an explicit mention. Set `channels.defaults.implicitMentions.quotedBot: false` to stop it from bypassing the mention requirement; LINE reads that shared default and has no channel-scoped `implicitMentions` block of its own. See [Groups](/channels/groups). The bot recognizes a quote of its own message from the most recent ones it remembers sending (a few hundred per account), so quoting an older message, or one sent before the last Gateway restart, still needs a mention.
- Static sender access groups can be referenced from `allowFrom`, `groupAllowFrom`, and per-group `allowFrom` with `accessGroup:<name>`; see [Access groups](/channels/access-groups).
- Runtime note: if `channels.line` is completely missing, runtime falls back to `groupPolicy="allowlist"` for group checks (even if `channels.defaults.groupPolicy` is set).

LINE IDs are case-sensitive. Valid IDs look like:

- User: `U` + 32 hex chars
- Group: `C` + 32 hex chars
- Room: `R` + 32 hex chars

## Directory

`openclaw directory peers list --channel line` lists user IDs from the selected
account's `allowFrom`, `groupAllowFrom`, and per-group `allowFrom` entries.
`openclaw directory groups list --channel line` lists configured group and room
IDs. Prefixes normalize to sendable IDs, duplicates appear once, and `*` and
`accessGroup:<name>` entries are omitted. Use `--account`, `--query`, `--limit`,
and `--json` as described in [Directory](/cli/directory).

These lists read configuration; they do not fetch a live LINE contact roster or
include approvals stored through pairing.

## Group join introductions

When the bot joins an allowed group or multi-person room, it posts one
introduction there. LINE exposes a group name through its group summary API, but
no room name or topic for multi-person rooms. The Messaging API cannot read prior
messages, so introductions use only available metadata and ask what the room
wants the bot to take on rather than inventing activity.

Introductions are enabled by default. Set `channels.line.joinIntro: false` to
disable them, or use `channels.line.accounts.<accountId>.joinIntro` to override
one account. They never run in one-to-one user chats or when another member joins.
See [group join introductions](/channels#group-join-introductions) for room
admission, once-per-room behavior, and the no-tools turn that treats room content
as untrusted.

## Message behavior

- Text is chunked at 5000 characters.
- Markdown formatting is stripped; code blocks and tables are converted into Flex
  cards when possible.
- Streaming responses are buffered; LINE receives full chunks. The loading
  animation runs only in one-to-one chats — LINE's loading API accepts a user id
  and rejects group and room ids — so a group reply arrives without one. Heartbeat
  turns also show the loading animation while the reply is generated.
- Media downloads are capped by `channels.line.mediaMaxMb` (default 10).
- Inbound media is saved under `~/.openclaw/media/inbound/` before it is passed
  to the agent, matching the shared media store used by other channel plugins.
- LINE webhooks carry ids but no names, so the sender's display name and the
  group's name are fetched once and cached for five minutes. Group and room
  members are read through their conversation, which is the only way to see a
  member who has not added the bot as a friend. If either lookup fails the raw
  id is used and the message is still delivered. Multi-person rooms have no name
  API, so they keep their room id.
- LINE describes inline emoji with metadata and alternative text. Empty `()`
  alternatives reach the agent as `[emoji]`; meaningful alternatives such as
  `(hello)` and parentheses typed by the sender are preserved.

## Structured rich messages

Use the shared message presentation fields for portable choices. LINE renders
`buttons` blocks as Flex controls and `select` blocks as quick replies. A two-button
block is the portable confirm-style form.

A `buttons` block renders a Flex card that carries the presentation's title and
text. A presentation whose only control is a `select` renders no card, because
quick replies attach to the reply's own text message; its title and text blocks
are appended to that text instead. LINE draws at most 13 quick replies on one
message, counted across every `select` block in the reply rather than per block.
Each select keeps its prompt and any overflow options together in that text.
Prompts and overflow option names remain complete; only native quick-reply button
labels are shortened to LINE's 20-character limit.

```json5
{
  action: "send",
  message: "Choose an action",
  presentation: {
    title: "Menu",
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "Status", action: { type: "command", command: "/status" } },
          { label: "Website", action: { type: "url", url: "https://example.com" } },
        ],
      },
      {
        type: "select",
        placeholder: "Pick one",
        options: [
          { label: "Alpha", action: { type: "callback", value: "alpha" } },
          { label: "Help", action: { type: "command", command: "/help" } },
        ],
      },
    ],
  },
}
```

LINE-only output uses the schema-validated `channelData.line` fields on
`message(action="send")`. Send one location and/or one `card`. The supported card
types are `media_player`, `event`, `agenda`, `device`, and `appletv_remote`.

```json5
{
  action: "send",
  message: "Here you go",
  channelData: {
    line: {
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      card: {
        type: "event",
        title: "Team meeting",
        date: "2026-08-18",
        time: "10:00",
        location: "Conference room",
        description: "Weekly planning",
      },
    },
  },
}
```

Other card shapes:

```json5 validate=false
{ type: "media_player", title: "Song", artist: "Artist", source: "Living Room", status: "playing", imageUrl: "https://example.com/cover.jpg" }
{ type: "agenda", title: "Today", events: [{ title: "Standup", time: "09:00", location: "Online" }] }
{ type: "device", name: "TV", deviceType: "Streaming box", status: "Playing", controls: [{ label: "Pause", action: "pause" }] }
{ type: "appletv_remote", name: "Living Room", status: "Playing" }
```

Double-bracket strings such as `[[buttons: ...]]` are plain text and are not
interpreted as rich-message instructions.

The LINE plugin also ships a `/card` command for Flex message presets:

```text
/card info "Welcome" "Thanks for joining!"
```

Card images and icons must use HTTPS. OpenClaw removes images with malformed or
non-HTTPS URLs and adds an "Image unavailable" note when it fits within LINE's
30 KB bubble and 50 KB carousel limits. Video
heroes keep their required alternative content: an unusable video or preview URL
falls back to that content, and an unusable alternative image becomes a text box.
Invalid template thumbnails are removed; carousel thumbnails are removed together
so every column keeps the same image layout. Text and action buttons stay intact.

## ACP support

LINE supports ACP (Agent Communication Protocol) conversation bindings:

- `/acp spawn <agent> --bind here` binds the current LINE chat to an ACP session without creating a child thread.
- Configured ACP bindings and active conversation-bound ACP sessions work on LINE like other conversation channels.

See [ACP agents](/tools/acp-agents) for details.

## Outbound media

The LINE plugin sends images, videos, and audio through the agent message tool:

- **Images**: sent as LINE image messages; the preview image defaults to the media URL.
- **Videos**: require a preview image; set `channelData.line.previewImageUrl` to an image URL.
- **Audio**: sent as LINE audio messages; duration defaults to 60 seconds unless `channelData.line.durationMs` is set.

When `mediaKind` is omitted, LINE infers it from LINE-specific options or the URL
suffix. Native suffix inference supports JPEG/PNG, MP4, and MP3/M4A; suffixless URLs
retain the image fallback. Other suffixed URLs and inferred MP4 without a preview
become text links. Explicit video still requires `previewImageUrl`.

Outbound media URLs must be public HTTPS URLs of at most 2000 characters. OpenClaw
validates the target hostname before handing the URL to LINE and rejects loopback,
link-local, and private-network targets.

A media send that carries a caption arrives as two LINE messages, the caption first
and the media after it, because every physical send is recorded separately so an
interrupted one can be resolved (see
[Outbound durability](#outbound-durability)).
They are two requests, not one, so a failure between them leaves the caption
delivered and the media not. The caption goes through the same markdown handling as
an agent reply, so a table in it arrives as a card rather than as literal pipes.

## Troubleshooting

- **Webhook verification fails:** ensure the webhook URL is HTTPS and the
  `channelSecret` matches the LINE console.
- **No inbound events:** confirm the webhook path matches `channels.line.webhookPath`
  and that the gateway is reachable from LINE.
- **Media download errors:** raise `channels.line.mediaMaxMb` if media exceeds the
  default limit.
- **Pushes refused with HTTP 429:** Run
  `openclaw channels status --channel line --probe --json`. For a limited allowance,
  the account’s `quota` contains `used` and `limit`. Missing quota is unknown, not unlimited.
  A healthy bot identity can coexist with an exhausted push allowance. Check the
  account allowance or plan in LINE Official Account Manager before retrying;
  429 can also reflect rate limits or temporary message reservations. Ordinary
  reply-token messages do not consume this monthly allowance, unlike pushes.
  See [LINE message pricing](https://developers.line.biz/en/docs/messaging-api/pricing/).
- **Bot silently skips messages (events dead-lettered):** `openclaw logs` shows
  `line: spooled update <id> ... dead-lettered` lines with the failure reason.
  Inspect with `openclaw channels dead-letters list --channel line --account default`
  and check the failure reason before recovering: `resubmit` re-enqueues by event
  id without checking why the event failed. After fixing the cause of a failure
  with no committed side effects (for example `retry-limit-exceeded` after a
  provider outage), re-enqueue one event with
  `openclaw channels dead-letters resubmit <event-id> --channel line --account default`.
  Never resubmit a `delivery-side-effects-committed` event: that reason means the
  delivery already adopted an agent turn or consumed its reply token, so
  re-enqueuing repeats the committed work — for example a second visible reply.
  `openclaw health` reports dead-letter counts and `openclaw doctor` names
  affected accounts.
- **`handler-timeout` retries:** the delivery was claimed but neither reached
  agent-turn adoption nor reported deferred progress for 5 minutes. This is a
  stall _before_ the turn starts —
  adoption clears the watchdog, so a turn that is already running is never the
  cause and is never cut off by it. Look at the dispatch path instead: the
  delivery preparation that runs between claim and adoption, such as inbound
  media download or a Gateway that is not accepting new work. This does not
  dead-letter the event; `openclaw logs` shows
  `applying retry policy (handler-timeout)` and the event waits out its backoff
  with `handler-timeout` as its last error. A stall that keeps repeating is what
  eventually exhausts the retry limit, so an event that stalls its way to a dead
  letter lands under `retry-limit-exceeded`, not under a timeout reason. Check
  `openclaw logs --follow` around the affected event id.
- **A reply that could not be reconciled after a restart:** see
  [Outbound durability](#outbound-durability) for what each of those messages means
  and which of them are ordinary.

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening

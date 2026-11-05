# Comments, and a narrower base schema: spec

Status: **proposed** November 6, 2026.

This spec amends the [conversations and Activity spec](conversations-and-activity-spec.md)
(D1, D7, 4.1, 5.4), the [merged schema, events and history spec](schema-events-and-history-spec.md)
(event links) and [FRONTEND.md](../FRONTEND.md) (record page). It adds one
concept, comments. It also removes the `note` event type from the base template, and
stops events from being linked to other events.

## 1. Why

### 1.1 Two kinds of writing share one tool

People working together in a workspace need to talk about records. For example:
"is this the right email?", "don't contact him before January", or "I'll
take this one". Today the only place to write is **Write a note**, which
logs a `note` event. An event is memory. It is dated, it has a source
identity, it appears in the Activity feed and in timelines, and claims can
cite it as evidence. A remark to a colleague is none of those. Logging it
as an event puts team chatter into the evidence model and the feed.

### 1.2 Events about events mix two levels

An event's `about` may name another event. That lets a note be "about" a
meeting, and makes every event page carry an Activity tab of its own:
activity inside an activity. An event is something that happened among
people and organizations. What people want to attach to a meeting is a
comment on it, not a second event.

### 1.3 Note has no meaning of its own

Every base type should mean the same thing in every workspace. Person,
company, task and conversation do. `note` is defined by its form, some text,
rather than by what it is. What people call a note already has a better
home:

| What the note really is                              | Where it belongs                                                |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| A person's remark to the team about a record         | A comment (this spec)                                           |
| A summary of a meeting, call or email                | A `conversation`'s summary                                      |
| Something learned about a person or a company        | A value on the record, or a fact (`remember`)                   |
| Notes a source system keeps (CRM or notetaker notes) | An event type the workspace adds (D4 of the conversations spec) |

A catch-all base type also invites agents to log anything as "a note". That
is the vagueness the conversation type was designed to remove.

## 2. Scope

In scope:

- comments on every record, entity or event: storage, REST, SDK, MCP read
  access and the web app;
- `about` links narrowed to entities;
- `note` removed from the base template, and Write a note replaced.

Out of scope:

- mentions and notifications;
- replies (threads);
- reactions;
- comments written by agents or integrations (open questions in section 7);
- an edit history for comments.

## 3. Decisions

| #   | Decision                                                                                                                                       | Replaces                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| C1  | A **comment** is plain text a person writes on a record, entity or event. It is not an event, not an assertion and not evidence.               | Write a note as the place for people to write |
| C2  | Only `user` actors write comments. Agents and integrations can read them.                                                                      | none                                          |
| C3  | Agents see comments as context. Nothing can cite a comment as a source. A fact in a comment becomes memory only through the usual write paths. | none                                          |
| C4  | An event's `about` and `participants` name entities only. An event cannot be linked to another event.                                          | `about` may name any entity or event          |
| C5  | The base template adds one event type: `conversation`. `note` keeps its universal ID, so a template that adds notes still matches by ID.       | `conversation` and `note` (D1)                |
| C6  | The web app replaces Write a note with comments. People still don't log events in the app; they comment.                                       | D7                                            |

## 4. System design

### 4.1 Comments (C1–C3)

A comment has:

- an ID;
- the workspace;
- the record it is on;
- a body (plain text, 1 to 10,000 characters, line breaks kept);
- its author (the `Actor` from the API key, never from the payload);
- `createdAt`, `updatedAt` and `editedAt` (null until the body changes).

Comments live in their own `comments` table, with row-level security like
every workspace table. Comments sit outside the evidence model:

- they don't touch `field_assertions`, `records.data`, facts, rollups or the
  timeline;
- they never appear in the Activity feed or the events query.

**Who may do what:**

| Action                   | Who                                      |
| ------------------------ | ---------------------------------------- |
| Read a record's comments | Any key with `read`                      |
| Write a comment          | A `user` key with `write`                |
| Edit a comment           | Its author                               |
| Delete a comment         | Its author, or a `user` key with `admin` |

**Lifecycle, following the record's rules:**

- **Delete:** deleting a record hides its comments with it.
- **Merge:** a merge moves the loser's comments to the survivor and keeps their
  authors and times.
- **`forget`:** hard-deletes the comments on every record it erases.
  - Comments on other records that mention the person by name are not found
    automatically. This is the same limit `forget` has for free text in values.
  - `forget` reports how many comments it removed.

**Agents (C3):**

- `get_record` returns the record's newest 20 comments and a total count.
- A new MCP tool, `list_comments`, pages through the rest.
- The `schema_design` and memory guides say that:
  - comments are what people told each other;
  - comments are context for deciding what to do, never a source to cite;
  - when a comment states something durable ("she moved to Berlin"), the
    agent writes it as a value or a fact. The value then goes through review
    like any agent value.

### 4.2 REST and SDK

| Route                           | Scope                   | Purpose                                  |
| ------------------------------- | ----------------------- | ---------------------------------------- |
| `GET /v1/records/:id/comments`  | `read`                  | A record's comments, newest first, paged |
| `POST /v1/records/:id/comments` | `write`, user           | Add a comment                            |
| `PATCH /v1/comments/:id`        | author                  | Edit the body                            |
| `DELETE /v1/comments/:id`       | author, or `admin` user | Delete                                   |

- **A merged record ID:** a comment request sent to it follows the merge, as other record routes do.
- **Writes:** they take an `Idempotency-Key` like every other write.
- **SDK:** the methods are `listComments`, `addComment`, `editComment` and `deleteComment`.

### 4.3 Events link to entities only (C4)

**On the server:**

- `log_event`, `POST /v1/events` and adding event links refuse an event in
  `about` with 422 `invalid_link`, naming the record.
- Participants are already entities only.
- An event's own relation fields are not affected. This decision is about the
  event-link model, not the schema.

**Existing links:**

- An existing `about` link to an event stays and is still returned, so no
  memory changes under anyone.
- It can be removed but not added again.
- The upgrade logs a count per workspace. In the record view, the "about"
  list shows such a link with no special treatment.

### 4.4 The base template (C5)

- **New workspaces:** they get company, person, task and `conversation`, plus the
  hidden internal note, which is system plumbing, not part of the schema
  people see.
- **Existing workspaces:** they keep their `note` type and its events, because upgrades
  only add. `note` was never a protected object, so an admin can move its
  events (`move_events`) and delete the type when they choose to.
- **The reserved universal ID:** `BASE_EVENT_TYPE_IDS.note` stays reserved. A
  template or agent that adds a note type uses it, so notes are recognized
  across workspaces.
- **Agent-facing text:** the MCP instructions and guides stop offering `note`
  as a default. D4 already covers adding one when a source keeps notes.

## 5. Frontend design

### 5.1 Comments on every record page

**On entity pages:**

- A **Comments** tab joins Facts, Activity, Timeline and Open tasks.
- It shows a count, and it opens first when the record has comments and no
  other tab was asked for.

**On event pages:**

- The tabs become:
  - **Comments**;
  - **Claims**: the claims and facts that cite this event, which today sit
    behind the "Open event and the claims citing it" link;
  - **History**: edits to the event's fields.
- Activity, Facts and Open tasks go away. Activity goes because of C4.
  Facts goes because facts are about entities; an event appears in Claims as
  their source.

**General rule:** the Open tasks tab shows only on object types that some
task relation field can point at, on any record page.

**The comment list and box:**

- Comments are listed oldest first, as a conversation reads, with the author,
  the time, and "edited" when it applies.
- The box sits at the bottom of the list.
  - Enter adds a line, and ⌘/Ctrl+Enter posts.
  - A draft survives switching tabs.
  - Posting uses one idempotency key per draft, as Write a note does today.
- People see Edit and Delete only on what they may change.
- Read-only and agent sessions see the list without the box.

### 5.2 What goes away

- **Write a note:** the button on the Activity feed and on the Notes list,
  and its dialog, are removed.
- **Pickers:** the About picker and the Activity feed's **Linked** picker
  offer entities only (C4).

### 5.3 Developer view

- Comments show their ID and author actor.
- The Comments tab names its REST path.

## 6. Implementation order

| Phase | What                                                                                 | Depends on |
| ----- | ------------------------------------------------------------------------------------ | ---------- |
| 1     | Comments table, REST, SDK, permissions, merge, delete and `forget` (4.1, 4.2)        | none       |
| 2     | Comments in the web app, and the event-page tabs (5.1, 5.3)                          | 1          |
| 3     | Agent read access and guide text (4.1)                                               | 1          |
| 4     | `about` limited to entities, and the pickers (4.3, 5.2)                              | none       |
| 5     | `note` out of the base template, Write a note removed, and the agent text (4.4, 5.2) | 2          |

Phase 5 ships with or after phase 2, so people never lose their place to write.

## 7. Open questions

1. **Agents writing comments.** An agent could ask a person something on a
   record: "two emails for Dana; which is right?" The review queue already
   covers conflicting values. Recommendation: wait until there is a question
   the review queue can't express.
2. **Imported comments.** CRMs keep comment threads, written by people who
   may not be Retainer users. Should an integration import them as comments
   with an external author, or as events of a workspace type?
   Recommendation: decide with the first CRM import.
3. **Search.** Should the command palette find comments? Recommendation: yes,
   as a separate result group, once comments have users.
4. **Mentions and notifications.** These need user identities beyond API
   keys, so they are deferred.

## 8. Acceptance

- A person can comment on a company and on a conversation, edit and delete
  their own comment, and an admin can delete anyone's.
- An agent key can read comments through `get_record` and `list_comments`,
  and gets 403 when it writes one.
- A comment never appears in the Activity feed, the events query, a
  timeline or a fact's sources.
- Merging two records keeps both records' comments on the survivor, and
  `forget` removes the comments on erased records.
- `log_event` with an event in `about` returns 422 `invalid_link`. Existing
  links to events still read and can be removed.
- A new workspace has no `note` type. An existing workspace keeps its notes
  and can delete the type.
- Event pages show Comments, Claims and History, and no Activity tab.
- Concurrency test: two posts with one idempotency key create one comment.

## 9. Documents to update

ARCHITECTURE.md (data model, event links, base template, `forget`),
FRONTEND.md (record page), `docs/rest-api.md`, `docs/sdk.md`,
`docs/agents.md`, the conversations spec (D1 and D7 marked as amended by
this spec), and the MCP instructions and guides.

# Claude Activity

A local, live dashboard for everything [Claude Code](https://claude.com/claude-code) does on your computer: what it's doing right now, every file it writes or edits, where your tokens go, and every session, tool, MCP server, memory file and agent.

It reads the records Claude Code already keeps in `~/.claude`. Nothing to install into Claude Code, no API key, no dependencies, and nothing leaves your machine.

> Unofficial. Not affiliated with or endorsed by Anthropic.

## What's in it

- **Live strip:** what's running now, tool calls and output tokens in the last hour, the latest action, and a 3-hour sparkline.
- **Code screen:** an editor view that replays every change Claude makes as a diff with real line numbers, typing new changes out as they land. It has file tabs, a change minimap, burst grouping and deleted-file markers.
- **Token usage:** exact totals by token type, project, session, model and time, plus an estimated split by *action* (each tool, thinking, re-reading history, re-caching after a pause…) that always adds up to the exact totals. Switch between raw tokens and estimated cost, and between today, 7 days and all time.
- **AI review (optional):** a senior-engineer review of any change, with a verdict, findings by category and line, and suggested fixes. It can also apply a fix you accept.
- **Activity feed, sessions, tools & MCP, memory, context & settings, agents & schedules:** everything Claude Code has done, searchable.

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer, and Claude Code installed and used at least once.

```
git clone https://github.com/<you>/claude-activity.git
cd claude-activity
npm start
```

Then open **http://127.0.0.1:4317**. It updates every 5 seconds.

## Settings

All optional, set as environment variables:

| Variable | What it does | Default |
|---|---|---|
| `CA_PORT` | Port to serve on | `4317` |
| `CA_HOST` | Address to bind. Keep it local unless you know you need otherwise | `127.0.0.1` |
| `CA_WATCH_REPOS` | Git repos (separated by `;` or `,`) whose uncommitted changes and last 48 hours of commits also appear on the Code screen, including changes made outside Claude | none |
| `CA_AUTO_REVIEW` | `on` to review each changed file automatically once it stops changing | off |
| `CA_FIX_DIRS` | Folders (separated by `;` or `,`) where **Accept** may apply a review's fixes | none: Accept is off |
| `CLAUDE_BIN` | Path to Claude Code's CLI, if it isn't found automatically | auto |
| `CA_DATA_DIR` | Where Claude Activity keeps its own small files | `~/.claude-activity` |

Example (PowerShell):

```
$env:CA_WATCH_REPOS = "C:\code\my-app"; $env:CA_FIX_DIRS = "C:\code\my-app"; npm start
```

## AI review

Press **Review** under the Code screen for a review of the change on screen. It runs Claude Code's own CLI (`claude -p`) on **your Claude login and plan**, with read-only tools (Read, Grep, Glob), one review at a time. Turn on **Auto** to review each file once it has been quiet for 45 seconds, at most one review every 90 seconds.

**Accept** sends approved findings back to Claude to apply with the Edit tool, in that one file only. It works only in folders listed in `CA_FIX_DIRS`, and is hidden everywhere else.

Reviews and fixes keep no transcript, so their token use is recorded and counted in the Token usage panel.

## How token usage is measured

- **Exact:** every total, and the split by token type, model, project, session and time. They come from the usage Anthropic records for each model turn, counted once per turn. Claude Code stores one turn across several transcript lines that repeat its usage, so adding up lines naively would roughly triple the totals.
- **Estimated, but always adding up to the exact totals:** the split by action.
  - A turn's *output* is split across its reply text and each tool call's input, by size. What's left over is thinking.
  - A turn's *new context* is split across what was added since the previous turn: each tool's results, your messages, system reminders, and the previous reply being sent back. On a session's first turn, what's left over is setup (system prompt, tools, memory). After more than 5 minutes idle, the prompt cache has expired and the whole conversation is re-sent ("re-caching after a pause").
  - *Cache reads* are the conversation history, re-read on every turn.
- **Est. cost** weights tokens roughly the way plan limits do, using API price ratios: input 1, cache write 1.25, cache read 0.1, output 5, times 5 for Opus-class models, 3 for Sonnet and 1 for Haiku. It shows shares, not dollars.

## Privacy and security

- **Read-only:** it never writes to `~/.claude`. Its own files (reviews, settings) live in `~/.claude-activity`.
- **Local only:** it binds to `127.0.0.1` and only answers to local hostnames, which blocks DNS-rebinding pages. Anything that acts (a review, a fix) needs a header other websites can't send.
- **Secrets masked:** strings that look like credentials (API keys, GitHub tokens, chat-bot tokens, `password=…`) are masked before they reach the page.
- **Network:** nothing is sent anywhere, except the review prompts you start, which go to Claude through your own Claude Code CLI.
- **Your prompts, code and file paths are on the page.** Check screenshots before you share them.

## License

MIT

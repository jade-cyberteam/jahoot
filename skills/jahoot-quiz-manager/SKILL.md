---
name: jahoot-quiz-manager
description: Write, update, list, and delete live quizzes on quiz.jett.io (Jade's Kahoot-style quiz host). Use when asked to make a quiz, write quiz questions, turn notes or a document into a quiz, put a quiz on jett.io / quiz.jett.io, or update, list or delete an existing quiz.
---

# jahoot-quiz-manager

quiz.jett.io runs live multiplayer quizzes: a host puts a 6-digit passcode on a
screen, players join on their phones with a nickname, and questions are scored
on speed. You write the quizzes through its REST API with a bearer token.

**You write the questions yourself.** There is no model running on the server —
the API only stores and validates what you send. So the quality of a quiz is
entirely down to the questions you write, which makes the guidance under
*Writing good questions* the main job here, not the curl syntax.

## Token

Resolve the API token in this order and call it `$TOKEN` below:

1. `$JAHOOT_API_TOKEN` environment variable, if set
2. `cat ~/.config/jahoot/token`

If neither exists, stop and ask the user for the API token — never guess, and
never put the token in committed files.

## Operations

All quiz endpoints require `Authorization: Bearer $TOKEN`. Send
`X-Published-By` with the tool you are running in (`claude-code`, `cursor`,
etc.) on writes — it is recorded as the quiz's author.

Create a quiz (the server assigns the id):

```sh
curl -sS -X POST "https://quiz.jett.io/api/quizzes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Published-By: claude-code" \
  -H "Content-Type: application/json" \
  --data @quiz.json
```

List all quizzes:

```sh
curl -sS https://quiz.jett.io/api/quizzes -H "Authorization: Bearer $TOKEN"
```

Read one (do this before editing a quiz you didn't just write):

```sh
curl -sS "https://quiz.jett.io/api/quizzes/<id>" -H "Authorization: Bearer $TOKEN"
```

Replace one — PUT overwrites the whole quiz, so send every question, not just
the changed one:

```sh
curl -sS -X PUT "https://quiz.jett.io/api/quizzes/<id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Published-By: claude-code" \
  -H "Content-Type: application/json" \
  --data @quiz.json
```

Delete:

```sh
curl -sS -X DELETE "https://quiz.jett.io/api/quizzes/<id>" \
  -H "Authorization: Bearer $TOKEN"
```

Write the JSON to a file and use `--data @file.json` rather than inlining it —
quiz bodies are long, and shell quoting will mangle apostrophes in your
questions.

## Quiz format

```json
{
  "title": "NZ geography",
  "description": "Ten questions, mostly rivers",
  "questions": [
    {
      "type": "multiple",
      "text": "Which river is New Zealand's longest?",
      "timeLimit": 20,
      "points": 1000,
      "answers": [
        { "text": "Waikato", "correct": true },
        { "text": "Clutha", "correct": false },
        { "text": "Whanganui", "correct": false },
        { "text": "Rangitikei", "correct": false }
      ]
    },
    {
      "type": "boolean",
      "text": "Aoraki / Mount Cook is the highest peak in New Zealand.",
      "answer": true
    }
  ]
}
```

Field rules:

- `title` required, ≤ 120 chars. `description` optional, ≤ 500.
- `questions` 1–50. Each needs `text` (≤ 300 chars).
- `type` is `"multiple"` (default) or `"boolean"`.
- `timeLimit` seconds, 5–120, defaults to 20. `points` 0–2000, defaults to 1000.
  A correct answer scores full `points` if instant, decaying to half at the
  buzzer — so `points` sets a question's weight relative to the others.
- `answers` 2–6 entries, **exactly one** with `"correct": true`. More than one
  correct answer is rejected; multi-select is not supported.
- For `"boolean"`, send `"answer": true|false` instead of `answers`; it expands
  to True/False for you.

Two shorthands are also accepted, so don't rewrite a payload that uses them:
`"options": ["a","b"]` with `"correctIndex": 1`, and `"question"` as an alias
for `"text"`.

## Writing good questions

- **One unambiguous right answer.** The three wrong answers must be clearly
  wrong to someone who knows the topic. If a knowledgeable player could argue
  for two of them, rewrite the question.
- **Make the wrong answers plausible.** Distractors that are the right *kind* of
  thing — other rivers, other years within a decade — make a real question.
  Obvious filler ("Paris", "42", "None of the above") wastes the slot.
- **Keep it readable at a glance.** The question goes on a projector and the
  answers go on phones. Aim for under ~15 words per question and a few words
  per answer; long answers get truncated on small screens in practice.
- **Vary the position of the correct answer.** Don't leave it at index 0.
- **Pace the quiz.** 10–15 questions is a good length. Give harder or
  longer-to-read questions more `timeLimit`, not more `points`, unless the user
  actually wants them weighted.
- **Mix in a few true/false** for rhythm, but don't lean on them — they are a
  coin flip, so they reward guessing.
- 8–12 questions unless the user says otherwise; ask if they want a specific
  length or difficulty before writing 50.

When building a quiz from a document the user gave you, draw the questions from
what the document actually says, and don't invent facts to round out a set. If
the source only supports six good questions, write six and say so.

## After saving

A successful write returns JSON with `hostUrl`. **Always give the user that
URL** and tell them what it does:

> Saved "NZ geography" (10 questions) → https://quiz.jett.io/host/q_a1b2c3d4e5
> Open that to start a game; it shows a passcode for players to join at
> https://quiz.jett.io

- The host link is unlisted, not secret: anyone holding it can start a game.
  Players need only the passcode, no account.
- Editing a quiz does not affect a game already in progress — a running game
  keeps the questions it started with.
- Deleting is permanent and there is no version history. Before deleting, or
  before a PUT over a quiz the user didn't clearly ask you to replace, confirm
  with the user. If you are reworking a quiz, read it first so you can put back
  anything you aren't deliberately changing.

## Troubleshooting

- `401` — token missing or wrong; re-resolve the token, then ask the user.
- `400` — the body broke a field rule; the `error` string names the offending
  field and index (e.g. `questions[3] must have exactly one correct answer
  (found 2)`). Fix that question and resend.
- `404` on a quiz id — it was deleted, or the id is wrong; list the quizzes.
- `503` saying the quiz API is disabled — `API_TOKEN` is not set on the Worker;
  tell the user to run `npx wrangler secret put API_TOKEN`.
- Creating a quiz through the browser builder instead needs a Cloudflare Access
  login at https://quiz.jett.io/admin — that path is for the user, not for you.

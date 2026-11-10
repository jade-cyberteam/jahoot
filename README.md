# jahoot

Kahoot-style live quizzes at [quiz.jett.io](https://quiz.jett.io), on one
Cloudflare Worker.

- **Host** opens a quiz link, gets a 6-digit passcode on a projector.
- **Players** join at `quiz.jett.io` with just that passcode and a nickname.
  No accounts, no app.
- **Questions** are scored on speed — full points instantly, half at the buzzer.
- **Quizzes** are written either in the browser builder (behind Cloudflare
  Access) or by Claude Code through the REST API.

## First-time deploy

You need a Cloudflare login and the `jett.io` zone.

```sh
npm install --legacy-peer-deps
npx wrangler login
```

**1. Create the KV namespace** and put its id in `wrangler.jsonc`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`:

```sh
npx wrangler kv namespace create DATA
```

**2. Set the API token.** This is the bearer token AI tools use to write
quizzes. Generate something long and random:

```sh
openssl rand -base64 32 | npx wrangler secret put API_TOKEN
```

**3. Deploy**, which also creates the `quiz.jett.io` DNS record in the jett.io
zone:

```sh
npm run deploy
```

**4. Put Cloudflare Access in front of the builder.** In the dashboard, go to
Zero Trust → Access controls → Applications → Add a self-hosted application:

- Domain: `quiz.jett.io`, path: `admin`
- Policy: Allow, with an Emails rule naming your address
- Copy the **Application Audience (AUD) tag** from Additional settings

Then set the two vars in `wrangler.jsonc` and redeploy:

```jsonc
"vars": {
  "ACCESS_AUD": "<the AUD tag>",
  "ACCESS_TEAM_DOMAIN": "https://<your-team>.cloudflareaccess.com",
  "ALLOW_INSECURE_ADMIN": "0"
}
```

Scope the Access application to the `admin` path only. Putting it on the whole
hostname would make players log in to play, and would break the token API.

Until `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are set, `/admin` returns 403 — it
fails closed rather than serving the builder unprotected.

**5. Install the skill** so Claude Code can write quizzes:

```sh
cp -r skills/jahoot-quiz-manager ~/.claude/skills/
mkdir -p ~/.config/jahoot && printf '%s' '<the API_TOKEN>' > ~/.config/jahoot/token
chmod 600 ~/.config/jahoot/token
```

## Local development

```sh
cp .dev.vars.example .dev.vars   # API_TOKEN + ALLOW_INSECURE_ADMIN=1
npm run dev
```

`/admin` is open locally because `ALLOW_INSECURE_ADMIN=1`; everything else
behaves as in production. Local KV and Durable Objects are simulated, so the
placeholder namespace id is fine.

## Writing a quiz

Ask Claude Code — "make a 10-question quiz about NZ geography on quiz.jett.io"
— or POST it yourself:

```sh
curl -sS -X POST https://quiz.jett.io/api/quizzes \
  -H "Authorization: Bearer $JAHOOT_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "title": "NZ geography",
    "questions": [
      { "text": "Which river is New Zealand'\''s longest?",
        "answers": [
          { "text": "Waikato", "correct": true },
          { "text": "Clutha", "correct": false }
        ] }
    ]
  }'
```

The response carries `hostUrl`. Open it to run a game.

See `skills/jahoot-quiz-manager/SKILL.md` for the full field reference.

## Tests

```sh
npm test     # 45 tests in the Workers runtime
npm run check
```

They cover quiz validation and CRUD, both auth planes, the game state machine
and scoring, the storage alarm closing a question, the WebSocket protocol, and
that the answer key never reaches a client while a question is open.

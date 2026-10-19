# server-openai-api

Makes the agent look like an OpenAI model. Base URL `http://127.0.0.1:3180/p/server-openai-api/v1`, API key: the Sinty API token.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3180/p/server-openai-api/v1", api_key="snt_...")
r = client.chat.completions.create(model="sinty", messages=[{"role": "user", "content": "What is in my workspace?"}], user="max")
print(r.choices[0].message.content)
```

| Route | Does |
|---|---|
| `GET /v1/models` | one model, `sinty` |
| `POST /v1/chat/completions` | runs a turn; `stream: true` streams the model's text and the names of tools it calls |

Which session is used:

1. header `x-sinty-session: ses_…` or `metadata.session_id`: that session;
2. otherwise `user`: one session per user, remembered in `$DATA/sessions.json`;
3. otherwise a new session per request, with earlier messages from the request as a preamble.

The agent keeps its own history, so in an existing session only the newest user message is sent. The response has the header `x-sinty-session` and a `sinty` field with `session_id`, `turn_id` and `status`. If the turn waits for an approval or asks a question, the answer text says so. Approve in the Web UI, then send the next message to the same session.

Enable it in `config.yaml`: add `server-openai-api` to `plugins.enabled`.

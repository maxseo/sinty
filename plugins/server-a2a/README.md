# server-a2a

A small [A2A](https://a2a-protocol.org) surface, bearer token:

- `GET /p/server-a2a/.well-known/agent-card.json`
- `POST /p/server-a2a/a2a` JSON-RPC `message/send`. `contextId` is the Sinty session id. The result artifact is the agent's text. Streaming and the rest of the task lifecycle are not implemented.

Enable `server-a2a` in `plugins.enabled`.

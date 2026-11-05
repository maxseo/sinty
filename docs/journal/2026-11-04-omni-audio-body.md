# Qwen Omni audio body

`audio.listen` reached `runninghub/qwen/qwen3.8-omni-flash` and the gateway answered `The request parameters are not supported by this model`. The clip had already been written, so this was the chat body, not the temp-file permission.

Qwen Omni chat completions take local audio as `input_audio.data` with the prefix `data:;base64,` and need `modalities: ["text"]` when the reply should be text. The OpenAI-compat body was sending raw base64 and no modalities. Streaming was already on, which this model requires.

`buildBody` in `plugins/provider-openai-compat/src/index.ts` applies that shape only when the model id contains `omni`. Other audio models keep raw base64. The listen route was left as the user set it.

import { streamSse } from "@continuedev/fetch";
import { ChatCompletionCreateParams } from "openai/resources/index";

import {
  ChatMessage,
  Chunk,
  CompletionOptions,
  LLMOptions,
} from "../../index.js";
import { osModelsEditPrompt } from "../templates/edit.js";

import OpenAI from "./OpenAI.js";

class SiliconFlow extends OpenAI {
  static providerName = "siliconflow";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.siliconflow.cn/v1/",
    model: "Qwen/Qwen2.5-Coder-32B-Instruct",
    promptTemplates: {
      edit: osModelsEditPrompt,
    },
    useLegacyCompletionsEndpoint: false,
  };
  maxStopWords: number | undefined = 16;

  // SiliconFlow's modern chat models (e.g. Qwen3.5) reject the legacy
  // /v1/completions endpoint with HTTP 500 "S0110 Request failed: Unknown
  // error". The per-model `useLegacyCompletionsEndpoint: false` below is not
  // enough: the apply/edit pipeline (core/edit/recursiveStream.ts) calls
  // streamComplete with `raw: true`, and OpenAI._streamChat lets `raw` override
  // that flag — silently forcing the legacy endpoint and breaking every edit
  // apply. Declaring completions unsupported routes ALL streams (including raw
  // ones) through /chat/completions instead. Tab-autocomplete FIM is unaffected:
  // _streamFim below posts to /completions directly and never consults this.
  supportsCompletions(): boolean {
    return false;
  }

  supportsFim(): boolean {
    return true;
  }

  protected _convertArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
  ): ChatCompletionCreateParams {
    const body = super._convertArgs(options, messages);

    // SiliconFlow disables Qwen3 thinking via the nested `chat_template_kwargs`
    // field — a top-level `enable_thinking` is silently ignored, so thinking
    // leaks into short tasks (title generation, edit applies) and burns tokens
    // it never shows. Route it through the field the API actually honors.
    if (options.reasoning === false && /qwen3/i.test(options.model ?? "")) {
      (body as any).chat_template_kwargs = { enable_thinking: false };
    }

    return body;
  }

  protected modifyChatBody(
    body: ChatCompletionCreateParams,
    options?: CompletionOptions,
  ): ChatCompletionCreateParams {
    // The chat path (LLM.streamChat) builds its body via toChatBody and never
    // goes through _convertArgs, so the reasoning toggle had no effect on chat
    // requests: `reasoning: false` leaked thinking into title generation
    // (hundreds of thinking tokens on a 40-token answer), and `reasoning: true`
    // never explicitly enabled thinking — whether the main chat produced any
    // reasoning at all was left to the server-side default. Map the toggle to
    // the field the API actually honors (nested chat_template_kwargs; a
    // top-level enable_thinking is silently ignored).
    if (options && /qwen3/i.test(options.model ?? body.model ?? "")) {
      if (options.reasoning === false) {
        (body as any).chat_template_kwargs = { enable_thinking: false };
      } else if (options.reasoning === true) {
        (body as any).chat_template_kwargs = { enable_thinking: true };
      }
    }
    return body;
  }

  async *_streamFim(
    prefix: string,
    suffix: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const endpoint = new URL("completions", this.apiBase);
    const resp = await this.fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: options.model,
        prompt: prefix,
        suffix,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        top_p: options.topP,
        frequency_penalty: options.frequencyPenalty,
        presence_penalty: options.presencePenalty,
        stop: options.stop,
        stream: true,
      }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal,
    });
    for await (const chunk of streamSse(resp)) {
      yield chunk.choices[0].text;
    }
  }

  async rerank(query: string, chunks: Chunk[]): Promise<number[]> {
    if (!query || query.trim() === "") {
      console.warn("[SiliconFlow] rerank: query is empty");
      return [];
    }

    if (!chunks || chunks.length === 0) {
      console.warn("[SiliconFlow] rerank: chunks is empty");
      return [];
    }

    const endpoint = new URL("rerank", this.apiBase);
    const resp = await this.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: chunks.map((chunk) => chunk.content),
      }),
    });

    if (!resp.ok) {
      throw new Error(await resp.text());
    }

    const data = (await resp.json()) as any;
    const results = data.results.sort((a: any, b: any) => a.index - b.index);
    return results.map((result: any) => result.relevance_score);
  }
}

export default SiliconFlow;

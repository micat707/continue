import { fetchwithRequestOptions } from "@continuedev/fetch";
import { ChatMessage, IDE, PromptLog } from "..";
import { ConfigHandler } from "../config/ConfigHandler";
import { FromCoreProtocol, ToCoreProtocol } from "../protocol";
import { IMessenger, Message } from "../protocol/messenger";

import { TTS } from "../util/tts";

export async function* llmStreamChat(
  configHandler: ConfigHandler,
  abortController: AbortController,
  msg: Message<ToCoreProtocol["llm/streamChat"][0]>,
  ide: IDE,
  messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
): AsyncGenerator<ChatMessage, PromptLog> {
  const { config } = await configHandler.loadConfig();
  if (!config) {
    throw new Error("Config not loaded");
  }

  // Stop TTS on new StreamChat
  if (config.experimental?.readResponseTTS) {
    void TTS.kill();
  }

  const {
    legacySlashCommandData,
    completionOptions,
    messages,
    messageOptions,
  } = msg.data;

  const model = config.selectedModelByRole.chat;

  if (!model) {
    throw new Error("No chat model selected");
  }

  // Log to return in case of error
  const errorPromptLog = {
    modelTitle: model?.title ?? model?.model,
    modelProvider: model?.underlyingProviderName ?? "unknown",
    completion: "",
    prompt: "",
    completionOptions: {
      ...msg.data.completionOptions,
      model: model?.model,
    },
  };

  try {
    if (legacySlashCommandData) {
      const { command, contextItems, historyIndex, input, selectedCode } =
        legacySlashCommandData;
      const slashCommand = config.slashCommands?.find(
        (sc) => sc.name === command.name,
      );
      if (!slashCommand) {
        throw new Error(`Unknown slash command ${command.name}`);
      }
      if (!slashCommand.run) {
        console.error(
          `Slash command ${command.name} (${command.source}) has no run function`,
        );
        throw new Error(`Slash command not found`);
      }

      const gen = slashCommand.run({
        input,
        history: messages,
        llm: model,
        contextItems,
        params: command.params,
        ide,
        addContextItem: (item) => {
          void messenger.request("addContextItem", {
            item,
            historyIndex,
          });
        },
        selectedCode,
        config,
        fetch: (url, init) =>
          fetchwithRequestOptions(
            url,
            {
              ...init,
              signal: abortController?.signal,
            },
            model.requestOptions,
          ),
        completionOptions,
        abortController,
      });
      let next = await gen.next();
      while (!next.done) {
        if (abortController?.signal?.aborted) {
          next = await gen.return(errorPromptLog);
          break;
        }
        if (next.value) {
          yield {
            role: "assistant",
            content: next.value,
          };
        }
        next = await gen.next();
      }
      if (!next.done) {
        throw new Error("Will never happen");
      }

      return next.value;
    } else {
      // Diagnostics for a turn that "hangs": proves whether the HTTP request
      // was actually fired, whether the model ever produced a chunk, and
      // whether the stream was aborted. Visible in the Extension Host log
      // (Help → Toggle Developer Tools → Console / Output "Extension Host").
      console.log(
        "[continue][core] → model.streamChat",
        model.title ?? model.model,
        `messages=${messages.length}`,
      );
      const gen = model.streamChat(
        messages,
        abortController?.signal,
        completionOptions,
        messageOptions,
      );
      let next = await gen.next();
      console.log(
        "[continue][core] ← model.streamChat first chunk",
        next.done ? "(done, no chunks)" : "",
      );
      while (!next.done) {
        if (abortController?.signal?.aborted) {
          console.log("[continue][core] ✕ model.streamChat aborted");
          next = await gen.return(errorPromptLog);
          break;
        }

        const chunk = next.value;

        yield chunk;
        next = await gen.next();
      }
      if (config.experimental?.readResponseTTS && "completion" in next.value) {
        void TTS.read(next.value?.completion);
      }

      if (!next.done) {
        throw new Error("Will never happen");
      }

      return next.value;
    }
  } catch (error: any) {
    // Temporary: print the real stack to the Extension Host Console. The
    // console-encoder strips stacks from the GUI-side log, so this is the only
    // place we can see where `reading 'filter'` actually originates.
    console.error(
      "[streamChat] ERROR:",
      error?.message,
      "\nSTACK:",
      error?.stack,
    );
    throw error;
  }
}

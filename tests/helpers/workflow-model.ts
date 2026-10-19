import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 as SdkMockLanguageModelV3 } from "ai/test";

/** Existing workflow scripts describe complete steps; expose those steps as provider streams too. */
export class MockLanguageModelV3 extends SdkMockLanguageModelV3 {
  constructor(options: ConstructorParameters<typeof SdkMockLanguageModelV3>[0]) {
    super({
      ...options,
      doStream: options?.doStream ?? (async (params) => {
        const result = await this.doGenerate(params);
        return {
          request: result.request,
          response: result.response,
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: result.warnings });
              for (const [index, part] of result.content.entries()) {
                if (part.type === "text" || part.type === "reasoning") {
                  const id = String(index);
                  controller.enqueue({ type: `${part.type}-start`, id, providerMetadata: part.providerMetadata });
                  controller.enqueue({ type: `${part.type}-delta`, id, delta: part.text });
                  controller.enqueue({ type: `${part.type}-end`, id });
                } else controller.enqueue(part);
              }
              controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata });
              controller.close();
            },
          }),
        };
      }),
    });
  }
}

/**
 * Shared OpenAI tool-call helper for the consolidation/extraction pipeline.
 *
 * Every pipeline step needs the same shape: force a single function call,
 * parse its JSON arguments, and surface token usage. This centralizes that
 * so extractor.ts / entity-extractor.ts / nightly.ts / graph-builder.ts /
 * reconcile.ts don't each hand-roll the OpenAI request/response plumbing.
 */

import OpenAI from "openai";

export interface ToolSpec {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCallResult {
  output: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

/**
 * Call a model with a single forced function/tool and return its parsed arguments.
 * Throws if the model doesn't return a call to the requested tool, or if the
 * arguments aren't valid JSON — callers that need lenient fallback behavior
 * should wrap this in their own try/catch (several already do).
 */
export async function callOpenAITool(params: {
  client: OpenAI;
  model: string;
  maxTokens?: number;
  tool: ToolSpec;
  prompt: string;
}): Promise<ToolCallResult> {
  const { client, model, maxTokens = 4096, tool, prompt } = params;

  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    tools: [{
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }],
    tool_choice: { type: "function", function: { name: tool.name } },
    messages: [{ role: "user", content: prompt }],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.find(
    (call) => call.type === "function" && call.function.name === tool.name,
  );
  const args = toolCall?.function.arguments;
  if (!args) throw new Error(`No OpenAI tool call arguments for "${tool.name}" in response`);

  let output: unknown;
  try {
    output = JSON.parse(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI tool call arguments for "${tool.name}" were not valid JSON: ${msg}`);
  }

  return {
    output,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  };
}

/** Plain (non-tool) text completion, for free-form summarization calls. */
export async function callOpenAIText(params: {
  client: OpenAI;
  model: string;
  maxTokens?: number;
  prompt: string;
}): Promise<string> {
  const { client, model, maxTokens = 1024, prompt } = params;

  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content ?? "";
}

import OpenAI from "openai";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const client = new OpenAI({
    apiKey: requiredEnv("OPENAI_API_KEY"),
    baseURL: process.env.OPENAI_BASE_URL,
  });
  const model = requiredEnv("OPENAI_MODEL");

  const stream = await client.responses.create({
    model,
    input: "请用一句话介绍你自己。",
    stream: true,
  });

  let answer = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      answer += event.delta;
      process.stdout.write(event.delta);
    }
  }

  process.stdout.write("\n");
  console.assert(answer.length > 0, "模型没有返回文本");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`请求失败：${message}`);
  process.exitCode = 1;
}

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

const model = process.env.MODEL ?? "gpt-5.6-luna";

async function main(): Promise<void> {
  console.log(`模型: ${model}\n`);

  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
    stream: true,
  });

  let fullText = "";
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;

    if (choice.delta.content) {
      // 将结果输出到控制台
      process.stdout.write(choice.delta.content);
      fullText += choice.delta.content;
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  console.log("\n");
  console.log("finish_reason:", finishReason);
  console.log("完整文本长度:", fullText.length);
}

await main();

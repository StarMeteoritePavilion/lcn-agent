import type { StateContext } from "../core/state.js";
import type { ExtensionAPI } from "../core/tools.js";

/**
 * 当前会话的执行方案；不包含未经验证的完成状态。
 *
 * 只保存“打算做什么”，不保存哪一步已完成：完成状态若由模型自己标记，无法核验。
 * - goal:  本次计划的目标。
 * - steps: 按执行顺序排列的步骤，至少 1 条、最多 20 条。
 */
type Plan = {
  goal: string;
  steps: string[];
};

/**
 * 模型参数和磁盘数据共用业务校验。
 * Schema 只能校验工具输入，读取磁盘后的 unknown 仍须检查。
 *
 * 只用 trim 判断空白，不修改用户批准的实际内容（首尾空格会原样存盘）。
 * `length` 按 UTF-16 代码单元计数，与 JS 字符串长度一致。
 *
 * @param value 待检查的值：工具参数，或磁盘上 `{ version, plan }` 里的 plan
 * @returns 通过校验的 Plan
 * @throws {Error} 字段不对、目标或步骤为空、超出条数 / 长度限制
 */
function parsePlan(value: unknown): Plan {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("goal" in value) ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    value.goal.length > 1000 ||
    !("steps" in value) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > 20
  ) {
    throw new Error("计划须包含非空目标和 1～20 个步骤，目标最多 1000 个 UTF-16 代码单元");
  }

  const steps = value.steps.map((step: unknown) => {
    if (typeof step !== "string" || !step.trim() || step.length > 1000) {
      throw new Error("每个计划步骤必须非空，最多 1000 个 UTF-16 代码单元");
    }
    return step;
  });

  // 只用 trim 判断空白，不修改用户批准的实际内容。
  return { goal: value.goal, steps };
}

/**
 * 计划扩展：按会话保存一个当前计划。
 *
 * - 工具 plan_set：经宿主逐次确认后整体替换；只存目标与步骤，不执行、不标记完成。
 * - 工具 plan_show：只读查看；宿主把它放进自动允许名单，不必逐次确认。
 * - 命令 /plan：用户直接查看，效果与 plan_show 相同。
 *
 * 计划“按会话隔离”：每个会话文件对应一份 `.lcn-agent/plans/{会话}.json`。
 * 命名空间是 `plans`；磁盘格式为 `{ version: 1, plan }`。
 *
 * 使用默认导出供组合入口复用，当前由 workflow.ts 默认装载；不要重复配置外部加载。
 *
 * @param api 宿主提供的注册及会话状态读写能力
 */
export default function registerPlan({
  registerTool,
  registerCommand,
  readState,
  writeState,
}: ExtensionAPI): void {
  /**
   * 读取当前会话的计划。
   *
   * 状态接口负责路径、JSON 和取消检查；这里只校验版本及 plan 业务字段。
   * 文件不存在返回 undefined；损坏或未知版本抛错，避免 plan_set 把它静默盖掉。
   */
  function planFor(context: StateContext): Plan | undefined {
    const data = readState(context, "plans");
    if (data === undefined) return undefined;

    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      Object.keys(data).length !== 2 ||
      !("version" in data) ||
      data.version !== 1 ||
      !("plan" in data)
    ) {
      throw new Error("计划数据损坏或版本不支持");
    }

    return parsePlan(data.plan);
  }

  /** 把计划格式化成给用户或模型看的多行文本；没有计划时给出提示。 */
  function showPlan(context: StateContext): string {
    const plan = planFor(context);
    if (!plan) return "当前会话暂无计划";

    return [`目标：${plan.goal}`, ...plan.steps.map((step, index) => `${index + 1}. ${step}`)].join(
      "\n",
    );
  }

  registerCommand({
    name: "plan",
    execute(_args, context) {
      return showPlan(context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "plan_show",
        description: "只读查看当前会话的目标和计划步骤，不执行步骤",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    execute(_args, context) {
      // Schema 已约束为空对象；只读查看，不使用参数。
      return showPlan(context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "plan_set",
        description:
          "经用户确认后整体替换当前会话的计划；仅保存目标与步骤，不执行步骤、不标记任务完成",
        parameters: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              minLength: 1,
              description: "本次计划的目标",
            },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1 },
              description: "按执行顺序排列的步骤",
            },
          },
          required: ["goal", "steps"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      const plan = parsePlan(args);

      // 先检查已有记录；损坏或未知版本不能被新计划静默覆盖。
      planFor(context);

      // 复用现有原子替换、取消检查和会话路径保护。
      writeState(context, "plans", { version: 1, plan });
      return "当前会话计划已保存；尚未执行计划步骤";
    },
  });
}

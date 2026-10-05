import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/** 通过入队和出队两个数组实现先进先出队列，T 为元素类型。 */
class FifoQueue<T> {
  /** 按入队顺序追加的元素，转移时从末尾取出。 */
  private incoming: T[] = [];
  /** 从 incoming 逆序转移的元素，末尾为下一项出队元素。 */
  private outgoing: T[] = [];

  /**
   * 获取尚未出队的元素总数。
   * @returns 两个内部数组中的元素数量之和；空队列返回 0。
   */
  get length(): number {
    return this.incoming.length + this.outgoing.length;
  }

  /**
   * 将元素追加到队列尾部。
   * @param value - 待入队的元素，按原值或对象引用保存。
   */
  enqueue(value: T): void {
    this.incoming.push(value);
  }

  /**
   * 取出并移除最早入队的元素。
   * @returns 队首元素；空队列返回 undefined，若入队值本身为 undefined 则返回值相同。
   * @remarks 出队数组为空时才逆序转移入队数组，以保持先进先出顺序。
   */
  dequeue(): T | undefined {
    if (this.outgoing.length === 0) {
      while (this.incoming.length > 0) {
        this.outgoing.push(this.incoming.pop()!);
      }
    }
    return this.outgoing.pop();
  }
}

/**
 * 缓存并异步分发事件，同时提供独立的最终结果 Promise；T 为事件类型，R 为结果类型。
 * @remarks
 * 所有迭代器共享事件队列，每个事件只交付一次，多个迭代器会分摊事件。
 * 事件和结果按原值或对象引用保存，不复制对象；队列没有容量限制。
 * 终结事件会禁止后续 push，但只有 end() 会唤醒全部剩余等待者。
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  /** 尚未交付给迭代器的事件队列。 */
  private queue = new FifoQueue<T>();
  /** 等待下一项事件的迭代器回调队列，按等待顺序唤醒。 */
  private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
  /** 是否已收到终结事件或显式调用 end，置为 true 后不再接受事件。 */
  private done = false;
  /** 由终结事件或显式结果完成的 Promise，与事件消费进度无关。 */
  private readonly finalResultPromise: Promise<R>;
  /** 完成最终结果 Promise 的回调，多次调用时只有首次结果生效。 */
  private resolveFinalResult!: (result: R) => void;
  /** 判断事件是否为终结事件的回调。 */
  private readonly isComplete: (event: T) => boolean;
  /** 从终结事件中提取最终结果的回调。 */
  private readonly extractResult: (event: T) => R;

  /**
   * 创建事件队列及最终结果 Promise，并保存终结事件处理规则。
   * @param isComplete - 判断事件是否结束流的回调，在 push 时同步执行。
   * @param extractResult - 从终结事件提取最终结果的回调，仅在 isComplete 返回 true 时执行。
   */
  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise(
      /**
       * 保存最终结果 Promise 的完成回调，供终结事件或 end 调用。
       * @param resolve - Promise 提供的完成回调。
       */
      (resolve: (value: R | PromiseLike<R>) => void): void => {
        this.resolveFinalResult = resolve;
      },
    );
  }

  /**
   * 将事件交付给最早等待的迭代器，或加入待消费队列。
   * @param event - 待发送事件；流已结束时忽略。
   * @throws isComplete 或 extractResult 抛出异常时，将异常同步传递给调用方。
   * @remarks
   * 终结事件在交付前完成 result() 并禁止后续 push，但该事件本身仍会交付。
   * 每次仅唤醒一个等待者；发送终结事件后仍需调用 end() 唤醒其他等待者。
   * extractResult 执行前已将流标记为结束；若其抛错，本次事件不会交付，最终结果也不会由该事件完成。
   */
  push(event: T): void {
    if (this.done) {
      return;
    }

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.enqueue(event);
    }
  }

  /**
   * 标记流已结束，唤醒所有等待者，并按需完成最终结果。
   * @param result - 显式提供的最终结果；省略或为 undefined 时不完成最终结果 Promise。
   * @remarks
   * 已缓存的事件不会被清空，迭代器会先消费这些事件再结束。
   * 若终结事件已完成 result()，再次提供结果不会替换首次结果。
   * 未收到终结事件且未提供非 undefined 结果时，result() 会继续等待，即使事件迭代已经结束。
   */
  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }

    while (this.waiting.length > 0) {
      const waiter = this.waiting.dequeue()!;
      waiter({ value: undefined, done: true });
    }
  }

  /**
   * 创建异步迭代器，依次交付队列中的事件或等待后续事件。
   * @returns 异步迭代器；队列为空且流已结束时，下一次迭代返回结束状态。
   * @remarks
   * 优先消费已缓存事件；流未结束且队列为空时，注册等待回调并暂停。
   * 本迭代器不取消生产者请求；提前退出消费不会自动调用 end()。
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.dequeue()!;
        continue;
      }
      if (this.done) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>(
        /**
         * 注册当前迭代器的等待回调，供 push 或 end 唤醒。
         * @param resolve - 接收下一项事件或迭代结束状态的 Promise 完成回调。
         */
        (resolve: (value: IteratorResult<T> | PromiseLike<IteratorResult<T>>) => void): void =>
          this.waiting.enqueue(resolve),
      );
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }

  /**
   * 获取由终结事件或显式 end 结果完成的最终结果 Promise。
   * @returns Promise 完成后得到最终结果；尚未提供结果时保持等待，每次调用返回同一个 Promise。
   * @remarks 无需消费事件即可等待结果；该流未设置拒绝回调，业务错误由具体结果类型表达。
   */
  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

/** 以 done 或 error 为终结事件，并将对应助手消息作为最终结果的事件流。 */
export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  /**
   * 创建助手消息事件流，配置完成事件和错误事件的结果提取规则。
   * @remarks error 事件中的助手消息作为正常完成的结果返回，由调用方检查 stopReason 和 errorMessage。
   */
  constructor() {
    super(
      /**
       * 判断助手事件是否结束本次消息生成。
       * @param event - 待判断的助手消息事件。
       * @returns done 或 error 事件返回 true，其他事件返回 false。
       */
      (event: AssistantMessageEvent): boolean => event.type === "done" || event.type === "error",
      /**
       * 从助手终结事件中提取最终消息。
       * @param event - 应为 done 或 error 的助手消息事件。
       * @returns done 的 message 或 error 的 error 字段所引用的助手消息。
       * @throws 传入非终结事件时抛出异常；正常 push 流程不会以此类事件调用本回调。
       */
      (event: AssistantMessageEvent): AssistantMessage => {
        if (event.type === "done") {
          return event.message;
        }
        if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}

/**
 * 创建独立的助手消息事件流。
 * @returns 尚未结束且最终结果仍待完成的新事件流。
 * @remarks 本函数只创建流容器，不发起模型请求或生成消息事件。
 */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}

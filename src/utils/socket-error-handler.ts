type HandlerFunction<Args extends unknown[]> = (...args: Args) => unknown;

type ErrorHandler = <Args extends unknown[]>(
  handler: HandlerFunction<Args>
) => (...args: Args) => void;

export const crashPrevent: ErrorHandler = (handler) => {
  return (...args) => {
    // Event handlers end with their ack callback — surface a thrown error
    // through it so a client emit never hangs on a server-side crash.
    const ack = [...args].findLast(
      (arg): arg is (...ackArgs: unknown[]) => void => typeof arg === 'function'
    );
    const fail = (err: unknown): void => {
      console.error(err);
      ack?.(errorResponseData('INTERNAL_ERROR'));
    };

    try {
      const ret = handler(...args);
      if (ret instanceof Promise) {
        // async handler
        ret.catch(fail);
      }
    } catch (e) {
      // sync handler
      fail(e);
    }
  };
};

export const errorResponseData = (errorCode: string, message?: string) => {
  return {
    _error: true,
    because: errorCode,
    message: message
  };
};

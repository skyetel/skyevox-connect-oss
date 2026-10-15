export interface SecondCallAnswerOperations {
  hold(sessionId: string): Promise<void>;
  answer(sessionId: string): Promise<void>;
  unhold(sessionId: string): Promise<void>;
  onRollbackError?(error: unknown): void;
}

export async function answerSecondCallTransaction(
  previousSessionId: string | null,
  waitingSessionId: string,
  operations: SecondCallAnswerOperations,
): Promise<string> {
  if (previousSessionId) await operations.hold(previousSessionId);
  try {
    await operations.answer(waitingSessionId);
    return waitingSessionId;
  } catch (error) {
    if (previousSessionId) {
      await operations.unhold(previousSessionId).catch((rollbackError) => {
        operations.onRollbackError?.(rollbackError);
      });
    }
    throw error;
  }
}

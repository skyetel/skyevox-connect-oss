import { SessionState, Web } from 'sip.js';
import type { Invitation, InvitationAcceptOptions, Session } from 'sip.js';

const pendingAnswers = new WeakMap<Invitation, Promise<void>>();

export function answerSession(session: Invitation, options?: InvitationAcceptOptions): Promise<void> {
  const pending = pendingAnswers.get(session);
  if (pending) return pending;
  if (session.state === SessionState.Established) return Promise.resolve();

  // Install the operation before accept() emits its synchronous Establishing event.
  const operation = Promise.resolve()
    .then(() => session.accept(options))
    .then(() => {
      // SIP.js can resolve accept() after a remote CANCEL without establishing a call.
      if (session.state !== SessionState.Established) {
        throw new Error('The incoming call ended before it could be answered.');
      }
    })
    .finally(() => pendingAnswers.delete(session));
  pendingAnswers.set(session, operation);
  return operation;
}

type FinalResponse = {
  message: {
    statusCode?: number;
    reasonPhrase?: string;
  };
};

function finalResponseError(operation: string, response: FinalResponse): Error {
  const status = response.message.statusCode;
  const reason = response.message.reasonPhrase;
  const detail = [status, reason].filter((part) => part !== undefined && part !== '').join(' ');
  return new Error(`${operation} rejected${detail ? ` with ${detail}` : ''}.`);
}

function awaitFinalResponse(
  operation: string,
  session: Session,
  send: (delegate: {
    onAccept: (response: FinalResponse) => void;
    onRedirect: (response: FinalResponse) => void;
    onReject: (response: FinalResponse) => void;
  }) => Promise<unknown>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const endedError = () => new Error(`${operation} failed because the call ended during media negotiation.`);
    const onStateChange = (state: SessionState) => {
      if (state === SessionState.Terminating || state === SessionState.Terminated) {
        finish(endedError());
      }
    };
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      session.stateChange.removeListener(onStateChange);
      if (error) reject(error);
      else resolve();
    };
    const delegate = {
      onAccept: () => finish(session.state === SessionState.Established ? undefined : endedError()),
      onRedirect: (response: FinalResponse) => finish(finalResponseError(operation, response)),
      onReject: (response: FinalResponse) => finish(finalResponseError(operation, response)),
    };
    session.stateChange.addListener(onStateChange);
    void send(delegate).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function setSessionHeld(session: Session, held: boolean): Promise<void> {
  if (session.state !== SessionState.Established) {
    throw new Error('Hold requires an established call.');
  }
  const previousModifiers = session.sessionDescriptionHandlerModifiersReInvite;
  const modifiersWithoutHold = previousModifiers.filter((modifier) => modifier !== Web.holdModifier);
  session.sessionDescriptionHandlerModifiersReInvite = held
    ? [...modifiersWithoutHold, Web.holdModifier]
    : modifiersWithoutHold;

  try {
    await awaitFinalResponse(
      held ? 'Hold' : 'Resume',
      session,
      (requestDelegate) => session.invite({ requestDelegate }),
    );
  } catch (error) {
    session.sessionDescriptionHandlerModifiersReInvite = previousModifiers;
    throw error;
  }
}

export async function completeBlindTransfer(
  session: Session,
  target: Parameters<Session['refer']>[0],
): Promise<void> {
  if (session.state !== SessionState.Established) {
    throw new Error('Transfer requires an established call.');
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Transfer confirmation timed out; call has not been ended.')), 32000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    void session.refer(target, {
      requestDelegate: {
        // 202 only accepts the REFER request, not the referred INVITE.
        onReject: (response) => finish(finalResponseError('Transfer', response)),
        onRedirect: (response) => finish(finalResponseError('Transfer', response)),
      },
      onNotify: (notification) => {
        void notification.accept().catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
        const match = /^SIP\/2\.0\s+(\d{3})(?:\s+([^\r\n]*))?/im.exec(notification.request.body);
        if (!match) {
          finish(new Error('Transfer returned an invalid confirmation.'));
          return;
        }
        const status = Number(match[1]);
        if (status < 200) return;
        finish(status < 300 ? undefined : finalResponseError('Transfer', {
          message: { statusCode: status, reasonPhrase: match[2] },
        }));
      },
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });

  // Only the final successful sipfrag proves that the remote call was transferred.
  if (session.state === SessionState.Established) {
    await session.bye();
  }
}

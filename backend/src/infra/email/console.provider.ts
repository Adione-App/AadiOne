/**
 * Development email provider — prints the message to the server log.
 *
 * Outside production the full message is logged (so a developer can follow a
 * reset link locally). In production NOTHING sensitive is logged and nothing
 * is delivered: a reset link in a log file is a credential leak, and until a
 * real provider is configured the email simply does not go out.
 */

import { moduleLogger } from '../../common/logger';
import { isProduction } from '../../config/env';
import type { EmailProvider, SendEmailInput, SendEmailResult } from './types';

const log = moduleLogger('email:console');

/** "s***@example.com" — enough to recognise, never the full address. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (isProduction) {
      log.warn(
        { to: maskEmail(input.to), subject: input.subject },
        'email NOT delivered: no email provider is configured (EMAIL_PROVIDER=console)',
      );
      return { messageId: null, delivered: false };
    }
    log.info({ to: maskEmail(input.to), subject: input.subject }, `DEV EMAIL to ${input.to}\n${input.text}`);
    return { messageId: `console-${Date.now()}`, delivered: true };
  }
}

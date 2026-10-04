import { moduleLogger } from '../../common/logger';
import { ConsoleEmailProvider } from './console.provider';
import type { EmailProvider } from './types';

const log = moduleLogger('email');

function createEmailProvider(): EmailProvider {
  // `console` is the only provider so far (env.EMAIL_PROVIDER); a real one is
  // selected here, behind the same port, without touching any caller.
  const provider: EmailProvider = new ConsoleEmailProvider();
  log.info({ provider: provider.name }, 'email provider initialised');
  return provider;
}

export const emailProvider: EmailProvider = createEmailProvider();
export { maskEmail } from './console.provider';
export type { EmailProvider, SendEmailInput, SendEmailResult } from './types';

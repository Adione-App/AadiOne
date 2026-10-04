/**
 * EmailProvider port.
 *
 * The provider only DELIVERS a message. Whatever secret a message carries (a
 * password-reset link) is created, stored hashed and verified by the auth
 * module, so swapping email vendors can never change those properties.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Marks a message that carries a secret (e.g. a reset link). A provider must
   * never write such a body to a log outside local development.
   */
  sensitive?: boolean;
}

export interface SendEmailResult {
  /** Provider's message id, for delivery investigation. */
  messageId: string | null;
  /** False when nothing was actually delivered (no provider configured). */
  delivered: boolean;
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

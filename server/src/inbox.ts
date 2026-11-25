import type { Email, InboxPort } from '@signvault/shared';

/** The address of the Acme Labs inbox that the agent reads. Every email the server delivers goes here. */
export const COMPANY_INBOX = 'payments@acme.test';

export class MemoryInbox implements InboxPort {
  private emails: Email[] = [];
  private nextId = 1;

  list(): Email[] {
    return [...this.emails];
  }

  get(id: string): Email | undefined {
    return this.emails.find((e) => e.id === id);
  }

  deliver(e: Omit<Email, 'id' | 'ts'>): Email {
    const email: Email = { ...e, id: `email-${this.nextId++}`, ts: Date.now() };
    this.emails.push(email);
    return email;
  }

  clear(): void {
    this.emails = [];
  }
}

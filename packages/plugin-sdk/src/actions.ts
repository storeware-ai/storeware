import { verifySignedRequest, type VerifyWebhookOptions } from './webhooks';

/**
 * What Storeware posts to one of your `[[automations.actions]]`, when a
 * merchant's automation reaches a step that asks your app to do it.
 *
 * Answer 2xx once it is done. Anything else, a timeout (10 seconds) or an
 * answer over 16 KB fails the step, and the merchant reads why on the run.
 * The same run and step can reach you twice, after a retry: the
 * `idempotency-key` header (`<runId>:<step.index>`) is the same both times, so
 * do the work once per key.
 */
export interface AutomationActionRequest {
  storeId: string;
  automationId: string;
  runId: string;
  /** Which step of the automation this is: its id, and where it sits. */
  step: { id: string; index: number };
  /** The action's `key`, as your manifest declares it. */
  action: string;
  /**
   * What the merchant filled in for your declared fields. Text may have named
   * a field of the event in braces, such as `{order.number}`, and arrives
   * with it filled in.
   */
  fields: Record<string, string | number | boolean>;
  /**
   * The event that started the automation, or null for one run on a
   * schedule or by hand. `fields` are named as a merchant's conditions name
   * them (`order.total`, or `data.points` for an app's trigger), and are left
   * empty for a platform event your app's scopes do not cover.
   */
  event: { id: string; topic: string; fields: Record<string, unknown> } | null;
}

/** The header carrying `<runId>:<step index>`, the same on every retry. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Verifies an automation action request and returns what it asked for.
 *
 * Signed with your installation's secret as the kind `action`, so a webhook
 * or a block request replayed at this endpoint fails.
 */
export function verifyActionRequest(
  options: VerifyWebhookOptions,
): Promise<AutomationActionRequest> {
  return verifySignedRequest<AutomationActionRequest>({ ...options, kind: 'action' });
}

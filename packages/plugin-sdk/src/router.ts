import {
  INSTALLATION_HEADER,
  verifyWebhook,
  type StorewareEvent,
  type VerifyWebhookOptions,
} from './webhooks';

/**
 * Webhook routing for an app's one webhook endpoint.
 *
 * Verifies first and dispatches second, so a handler can never be reached by
 * a forged request, and answers with a status Storeware understands: 200 for
 * handled, 401 for a signature that did not verify (Storeware does not retry
 * those), 200 for a topic with no handler (an event you subscribed to and
 * chose to ignore is not a failure), and 500 for a handler that threw, which
 * Storeware retries.
 */

export type EventHandler<T = unknown> = (event: StorewareEvent<T>) => void | Promise<void>;

/** Which installation a delivery is for, read before it is verified. */
export interface DeliveryAddress {
  storeId: string | null;
  /** Present on events about your app (`app.*`), absent on shop events. */
  installationId: string | null;
  /**
   * The installation the `storeware-installation` header names, which
   * Storeware sends on every delivery. Not signed: naming the wrong one only
   * picks a secret that fails.
   */
  namedInstallationId?: string | null;
}

/**
 * Where the webhook secret comes from. One string for an app in one shop;
 * otherwise a lookup by shop, because every installation has its own secret.
 * Return nothing for a shop you hold no secret for.
 */
export type SecretSource =
  | string
  | ((address: DeliveryAddress) => string | null | undefined | Promise<string | null | undefined>);

export interface WebhookRouter {
  /** Handles one topic, such as `order.paid.v1`. */
  on<T = unknown>(topic: string, handler: EventHandler<T>): WebhookRouter;
  /** Handles `app.installed.v1`, `app.uninstalled.v1` and the other events about your app. */
  onLifecycle(handler: EventHandler): WebhookRouter;
  /**
   * Handles the requests the law obliges you to act on: a customer's data asked
   * for, a customer erased, a shop's data to delete. Sent to `[privacy] url`
   * when your manifest declares one.
   */
  onCompliance(handler: EventHandler): WebhookRouter;
  /**
   * Handles what happens to what a shop pays you: a plan approved, changed,
   * declined or ended (`app_subscription.*`), a one-time charge accepted or
   * declined (`app_purchase.*`), a period's usage near or at its cap
   * (`app_usage.*`).
   */
  onBilling(handler: EventHandler): WebhookRouter;
  /** Verifies and dispatches one request. Works with any fetch-style server. */
  handle(request: Request): Promise<Response>;
}

function peek(rawBody: string): {
  event: string | null;
  address: DeliveryAddress;
  installGrant: string | null;
} {
  try {
    const body = JSON.parse(rawBody) as {
      event?: unknown;
      storeId?: unknown;
      data?: { installationId?: unknown; installGrant?: unknown };
    };
    return {
      event: typeof body.event === 'string' ? body.event : null,
      address: {
        storeId: typeof body.storeId === 'string' ? body.storeId : null,
        installationId:
          typeof body.data?.installationId === 'string' ? body.data.installationId : null,
      },
      installGrant: typeof body.data?.installGrant === 'string' ? body.data.installGrant : null,
    };
  } catch {
    return { event: null, address: { storeId: null, installationId: null }, installGrant: null };
  }
}

export function createWebhookRouter(options: {
  secret: SecretSource;
  /**
   * For `app.installed.v1` from a shop you hold no secret for yet, which is
   * every install that started in Storeware rather than at your site. Trade
   * the grant with `exchangeInstallGrant`, keep the tokens, and return the
   * webhook secret they came with; the delivery is then verified with it.
   *
   * Safe to do before verifying: a grant is spent only with your client
   * secret, once, for the one installation it names, so a forged delivery
   * carries a grant that buys nothing.
   */
  onInstallGrant?: (install: {
    grant: string;
    installationId: string | null;
    storeId: string | null;
  }) => Promise<string>;
  /** Runs after verifying and before any handler, for bookkeeping every event needs. */
  before?: EventHandler;
  toleranceSeconds?: number;
}): WebhookRouter {
  const handlers = new Map<string, EventHandler>();
  let lifecycle: EventHandler | null = null;
  let compliance: EventHandler | null = null;
  let billing: EventHandler | null = null;

  const secretFor = async (rawBody: string, named: string | null): Promise<string | null> => {
    if (typeof options.secret === 'string') return options.secret;
    const seen = peek(rawBody);
    const held = await options.secret({ ...seen.address, namedInstallationId: named });
    if (held) return held;
    if (seen.event === 'app.installed.v1' && seen.installGrant && options.onInstallGrant) {
      return options.onInstallGrant({ grant: seen.installGrant, ...seen.address });
    }
    return null;
  };

  const router: WebhookRouter = {
    on(topic, handler) {
      handlers.set(topic, handler as EventHandler);
      return router;
    },
    onLifecycle(handler) {
      lifecycle = handler;
      return router;
    },
    onCompliance(handler) {
      compliance = handler;
      return router;
    },
    onBilling(handler) {
      billing = handler;
      return router;
    },
    async handle(request) {
      const rawBody = await request.text();
      let event: StorewareEvent;
      try {
        const secret = await secretFor(rawBody, request.headers.get(INSTALLATION_HEADER));
        if (!secret) throw new Error('no secret for this shop');
        const verify: VerifyWebhookOptions = {
          secret,
          rawBody,
          signatureHeader: request.headers.get('storeware-signature'),
          ...(options.toleranceSeconds !== undefined
            ? { toleranceSeconds: options.toleranceSeconds }
            : {}),
        };
        event = await verifyWebhook(verify);
      } catch {
        return new Response('signature did not verify', { status: 401 });
      }

      if (options.before) {
        try {
          await options.before(event);
        } catch {
          return new Response('handler failed', { status: 500 });
        }
      }

      const handler =
        handlers.get(event.event) ??
        (event.event.startsWith('app.') ? lifecycle : null) ??
        (event.event.startsWith('compliance.') ? compliance : null) ??
        (event.event.startsWith('app_subscription.') ||
        event.event.startsWith('app_purchase.') ||
        event.event.startsWith('app_usage.')
          ? billing
          : null);
      if (!handler) return new Response(null, { status: 200 });

      try {
        await handler(event);
        return new Response(null, { status: 200 });
      } catch {
        return new Response('handler failed', { status: 500 });
      }
    },
  };
  return router;
}

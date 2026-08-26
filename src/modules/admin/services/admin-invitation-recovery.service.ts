import {
  AdminInvitationService,
  runAdminInvitationWorkerOnce,
} from "@/modules/admin/services/admin-invitations.service";
import { Auth0AdminClient, type Auth0AdminConfig } from "@/shared/auth0/admin-client";
import { env, type Env } from "@/shared/utils/env";
import { logger } from "@/shared/utils/logger";
import { prisma } from "@/shared/utils/prisma";

const RECOVERY_INTERVAL_MS = 2_000;
const LEASE_SAFETY_MARGIN_MS = 5_000;

interface TimerHandle {
  unref?: () => void;
}

interface RecoveryDependencies {
  runOnce: () => Promise<boolean>;
  defer: (task: () => void) => void;
  every: (task: () => void, delayMs: number) => TimerHandle;
  reportFailure: () => void;
}

type AdminInvitationAuth0Env = Pick<
  Env,
  | "AUTH0_DOMAIN"
  | "AUTH0_M2M_CLIENT_ID"
  | "AUTH0_M2M_CLIENT_SECRET"
  | "AUTH0_APPLICATION_CLIENT_ID"
  | "AUTH0_DATABASE_CONNECTION"
  | "AUTH0_REQUEST_TIMEOUT_MS"
>;

export function buildAdminInvitationAuth0Config(values: AdminInvitationAuth0Env): Auth0AdminConfig {
  return {
    domain: values.AUTH0_DOMAIN,
    m2mClientId: values.AUTH0_M2M_CLIENT_ID,
    m2mClientSecret: values.AUTH0_M2M_CLIENT_SECRET,
    applicationClientId: values.AUTH0_APPLICATION_CLIENT_ID,
    connection: values.AUTH0_DATABASE_CONNECTION,
    timeoutMs: values.AUTH0_REQUEST_TIMEOUT_MS,
  };
}

export function createAdminInvitationRecovery(dependencies: RecoveryDependencies): () => void {
  let prepared = false;
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (await dependencies.runOnce()) {
        await new Promise<void>((resolve) => dependencies.defer(resolve));
      }
    } catch {
      dependencies.reportFailure();
    } finally {
      draining = false;
    }
  }

  const tick = (): void => {
    void drain();
  };

  return (): void => {
    if (prepared) return;
    prepared = true;
    dependencies.defer(tick);
    dependencies.every(tick, RECOVERY_INTERVAL_MS).unref?.();
  };
}

const auth0AdminClient = new Auth0AdminClient(buildAdminInvitationAuth0Config(env));
export const adminInvitationService = new AdminInvitationService(prisma, auth0AdminClient);
const prepareRecovery = createAdminInvitationRecovery({
  runOnce: () =>
    runAdminInvitationWorkerOnce(
      prisma,
      auth0AdminClient,
      () => new Date(),
      2 * env.AUTH0_REQUEST_TIMEOUT_MS + LEASE_SAFETY_MARGIN_MS,
    ),
  defer: (task) => setImmediate(task),
  every: (task, delayMs) => setInterval(task, delayMs),
  reportFailure: () => {
    logger.error(
      { classification: "ADMIN_INVITATION_RECOVERY_FAILURE" },
      "Admin invitation recovery pass failed",
    );
  },
});

export function prepareAdminInvitationRecovery(): void {
  prepareRecovery();
}

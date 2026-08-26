import type { FastifyInstance } from 'fastify';

const SERVICE = 'infomemory-api';
const VERSION = '0.3.0';

export interface HealthRouteOptions {
  llmEnabled: boolean;
  feishuConfigured: boolean;
  feishuNotificationsEnabled: boolean;
  /** Non-sensitive indication that the OAuth installation routes exist. */
  feishuOAuthEnabled: boolean;
  exposeDetails: boolean;
  readinessCheck: () => Promise<void>;
}

export function registerHealthRoute(
  app: FastifyInstance,
  options: HealthRouteOptions,
): void {
  app.get('/health/live', async () => serviceHealth());

  app.get('/health/ready', async (request, reply) => {
    try {
      await options.readinessCheck();
      return {
        status: 'ready',
        service: SERVICE,
        checks: { database: 'ok' },
        requestId: request.id,
      };
    } catch {
      return reply.code(503).send({
        status: 'not_ready',
        service: SERVICE,
        checks: { database: 'error' },
        requestId: request.id,
      });
    }
  });

  app.get('/health', async () => ({
    ...serviceHealth(),
    connectorCapabilities: {
      feishuOAuthInstallation: options.feishuOAuthEnabled,
    },
    ...(options.exposeDetails ? {
      searchMode: 'sqlite_fts5',
      llmEnabled: options.llmEnabled,
      feishuConfigured: options.feishuConfigured,
      feishuNotificationsEnabled: options.feishuNotificationsEnabled,
      capabilities: [
        'first_party_web_workbench',
        'pre_persistence_secret_redaction',
        'safe_metadata_normalization',
        'tenant_owner_access_boundaries',
        'production_bearer_authentication',
        'idempotent_asset_ingestion',
        'sqlite_fts5_permission_filtered_search',
        'cursor_asset_pagination_and_owner_deletion',
        'citation_gated_answers',
        'feishu_callback_foundation',
        'feishu_search_and_answer_commands',
        'feishu_oauth_installation',
        'feishu_oauth_pkce_and_token_rotation',
        'durable_connector_inbox_outbox',
        'connector_queue_retry_and_dead_letter',
        'meeting_reminder_candidates',
        'strict_iana_time_zone_parsing',
        'request_rate_limiting',
        ...(options.feishuNotificationsEnabled ? ['feishu_outbound_notifications'] : []),
      ],
    } : {}),
  }));
}

function serviceHealth(): { status: 'ok'; service: string; version: string } {
  return { status: 'ok', service: SERVICE, version: VERSION };
}

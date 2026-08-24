export interface ClaimConnectorEventReceiptInput {
  tenantId: string;
  connector: string;
  eventId: string;
  receivedAt: string;
}

export interface ConnectorEventReceiptClaim {
  claimed: boolean;
  receivedAt: string;
}

export type ReleaseConnectorEventReceiptInput = ClaimConnectorEventReceiptInput;

/** Durable connector ingress deduplication. Business processing stays outside this port. */
export interface ConnectorEventReceiptRepository {
  claimConnectorEventReceipt(
    input: ClaimConnectorEventReceiptInput,
  ): Promise<ConnectorEventReceiptClaim>;
  releaseConnectorEventReceipt(
    input: ReleaseConnectorEventReceiptInput,
  ): Promise<boolean>;
}

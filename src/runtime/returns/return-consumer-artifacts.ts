import type { ReturnConsumerPlan, RoleReturnPackageV1 } from "./return-consumer-plan.js";

type ProcessReturnPlan = Extract<ReturnConsumerPlan, { status: "process" }>;

export interface ReturnConsumptionReceipt {
  receiptId: string;
  consumedAt: string;
  sourcePackage: string;
  sourceReturnId: string;
  taskId: string;
  consumer: string;
  status: "consumed";
  verificationChecklist: unknown;
  processedBy: string;
}

export interface ReturnConsumptionBridgeMarker {
  packageId: string;
  taskId: string;
  returnFile: string;
  receiptFile: string;
  writtenAt: string;
}

export interface ReturnConsumptionArtifacts {
  receiptId: string;
  receiptFileName: string;
  receipt: ReturnConsumptionReceipt;
  bridgeMarkerFileName: string | null;
  bridgeMarker: ReturnConsumptionBridgeMarker | null;
}

export function buildReturnConsumptionArtifacts(params: {
  plan: ProcessReturnPlan;
  pkg: RoleReturnPackageV1;
  consumedAt: string;
  stamp: string;
  consumer?: string;
  processedBy?: string;
}): ReturnConsumptionArtifacts {
  const consumer = params.consumer ?? "gateway-return-consumer-v1";
  const processedBy = params.processedBy ?? "system";
  const receiptId = `receipt-rrpkg-${safeReturnFilePart(params.plan.taskId || "unknown-task")}-${params.stamp}`;
  const receiptFileName = `${receiptId}.json`;
  const receipt: ReturnConsumptionReceipt = {
    receiptId,
    consumedAt: params.consumedAt,
    sourcePackage: params.plan.sourceFile,
    sourceReturnId: params.plan.returnId,
    taskId: params.plan.taskId,
    consumer,
    status: "consumed",
    verificationChecklist: params.pkg.verificationChecklist,
    processedBy,
  };

  if (!params.plan.returnId || !params.plan.taskId) {
    return {
      receiptId,
      receiptFileName,
      receipt,
      bridgeMarkerFileName: null,
      bridgeMarker: null,
    };
  }

  const bridgeMarkerFileName = `${safeReturnFilePart(params.plan.returnId)}.json`;
  return {
    receiptId,
    receiptFileName,
    receipt,
    bridgeMarkerFileName,
    bridgeMarker: {
      packageId: params.plan.returnId,
      taskId: params.plan.taskId,
      returnFile: params.plan.sourceFile,
      receiptFile: receiptFileName,
      writtenAt: params.consumedAt,
    },
  };
}

export function safeReturnFilePart(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
      .replace(/\s+/gu, "_")
      .slice(0, 120) || "unknown"
  );
}

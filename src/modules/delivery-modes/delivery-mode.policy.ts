import type { DeliveryModeType } from "@prisma/client";

export function requiresDestinationAddress(type: DeliveryModeType): boolean {
  return type === "PERSONAL_DELIVERY" || type === "SHIPPING_FLAT_RATE";
}

export function requiresTrackingNumber(type: DeliveryModeType): boolean {
  return type === "SHIPPING_FLAT_RATE";
}

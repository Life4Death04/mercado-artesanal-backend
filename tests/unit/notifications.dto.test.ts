/**
 * Unit tests — notifications DTO copy resolution (Cycle 5 notifications
 * Phase 4, RED phase), per the maintainer's copy-audience decision
 * (sdd/notifications/copy-audience-decision): ORDER_CREATED gets a SURGICAL
 * producer-audience copy override; every other (type, audience) combination
 * falls back to the flat `NOTIFICATION_COPY` table — NO full audience
 * dimension added.
 *
 * Scenarios covered:
 *   [NC-PRODUCER-ORDER-CREATED] `resolveNotificationCopy("ORDER_CREATED", "producer")`
 *     resolves to the override copy ("Nuevo pedido recibido" / "Has recibido
 *     un nuevo pedido para tus productos."), NOT the base consumer copy.
 *   [NC-CONSUMER-ORDER-CREATED] no audience (or the default/base call) for
 *     ORDER_CREATED resolves to the UNCHANGED base flat-table copy.
 *   [NC-FALLBACK-OTHER-TYPES] every OTHER NotificationType, even when called
 *     with a "producer" audience, falls back to the flat table (no override
 *     exists for anything but the single (ORDER_CREATED, producer) pair).
 *
 * Spec/design references:
 *   sdd/notifications/copy-audience-decision (maintainer decision #1338)
 *   sdd/notifications/design — "Emission wiring (the crux)"
 */
import { describe, expect, it } from "vitest";

import type { NotificationType } from "@prisma/client";

import { NOTIFICATION_COPY, resolveNotificationCopy } from "@/modules/notifications/dto/notifications.dto";

describe("resolveNotificationCopy — audience-aware copy override [NC]", () => {
  it("[NC-PRODUCER-ORDER-CREATED] ORDER_CREATED + producer audience resolves to the override copy, distinct from the base consumer copy", () => {
    const copy = resolveNotificationCopy("ORDER_CREATED", "producer");

    expect(copy).toEqual({
      title: "Nuevo pedido recibido",
      body: "Has recibido un nuevo pedido para tus productos.",
    });
    expect(copy).not.toEqual(NOTIFICATION_COPY.ORDER_CREATED);
  });

  it("[NC-CONSUMER-ORDER-CREATED] ORDER_CREATED with no audience falls back to the unchanged base flat-table copy", () => {
    expect(resolveNotificationCopy("ORDER_CREATED")).toEqual(NOTIFICATION_COPY.ORDER_CREATED);
    expect(resolveNotificationCopy("ORDER_CREATED")).toEqual({
      title: "Pedido creado",
      body: "Se ha creado un nuevo pedido.",
    });
  });

  it("[NC-FALLBACK-OTHER-TYPES] every other NotificationType with a producer audience falls back to the flat table — no override exists outside (ORDER_CREATED, producer)", () => {
    const otherTypes: NotificationType[] = [
      "PAYMENT_CONFIRMED",
      "SUBORDER_STATUS_CHANGED",
      "TRACKING_ASSIGNED",
      "INCIDENT_REPORTED",
      "INCIDENT_RESOLVED",
    ];

    for (const type of otherTypes) {
      expect(resolveNotificationCopy(type, "producer")).toEqual(NOTIFICATION_COPY[type]);
    }
  });
});

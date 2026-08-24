import type { NextFunction, Request, Response } from "express";

import { UnauthorizedError } from "@/shared/errors/errors";
import { validateBody } from "@/shared/validation/zod";

import { CreateDatabaseBackupBodySchema } from "../dto/database-backups.dto";
import * as databaseBackupsService from "../services/database-backups.service";

function requireAdminId(req: Request): string {
  if (!req.user) throw new UnauthorizedError("Admin user not found for this request");
  return req.user.id;
}

export async function createBackup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireAdminId(req);
    const input = validateBody(CreateDatabaseBackupBodySchema, req.body);
    const operation = await databaseBackupsService.create(actorId, input);

    res.status(202).location(operation.links.self).set("Retry-After", "2").json(operation);
  } catch (err) {
    next(err);
  }
}

export async function getBackupOperation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    requireAdminId(req);
    const { id } = req.params as { id: string };
    const operation = await databaseBackupsService.getOperation(id);

    res.status(200).set("Cache-Control", "no-store").json(operation);
  } catch (err) {
    next(err);
  }
}

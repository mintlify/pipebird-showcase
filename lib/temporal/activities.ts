import { Prisma, TransferStatus } from "@prisma/client";
import { parseISO } from "date-fns";
import { default as knex } from "knex";
import zlib from "node:zlib";
import crypto from "crypto";
import got from "got";
import * as csv from "csv";
import { z } from "zod";

import { useConnection } from "../connections.js";
import { db } from "../db.js";
import { logger } from "../logger.js";
import { uploadObject } from "../aws/upload.js";
import { getPresignedURL } from "../aws/signer.js";
import { LoadingActions } from "../load/index.js";
import SnowflakeLoader from "../snowflake/load.js";
import RedshiftLoader from "../redshift/load.js";

const finalizeTransfer = async ({
  transferId,
  status,
  objectUrl,
}: {
  transferId: number;
  status: TransferStatus;
  objectUrl?: string;
}) => {
  await db.transfer.update({
    where: {
      id: transferId,
    },
    data: {
      status,
    },
  });

  await db.transferResult.upsert({
    where: {
      transferId,
    },
    update: {
      finalizedAt: new Date(),
      objectUrl,
    },
    create: {
      transferId,
      finalizedAt: new Date(),
      objectUrl,
    },
  });
};

export async function processTransfer({ id }: { id: number }) {
  let loader: LoadingActions | null = null;
  try {
    const transfer = await db.transfer.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        share: {
          select: {
            id: true,
            tenantId: true,
            warehouseId: true,
            lastModifiedAt: true,
            destination: {
              select: {
                id: true,
                nickname: true,
                destinationType: true,
                warehouse: true,
                host: true,
                port: true,
                username: true,
                password: true,
                database: true,
                schema: true,
              },
            },
            configuration: {
              select: {
                id: true,
                columns: {
                  select: {
                    nameInSource: true,
                    nameInDestination: true,
                    viewColumn: true,
                  },
                },
                view: {
                  select: {
                    id: true,
                    tableName: true,
                    columns: true,
                    source: {
                      select: {
                        id: true,
                        host: true,
                        port: true,
                        username: true,
                        password: true,
                        database: true,
                        sourceType: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!transfer) {
      throw new Error(`Transfer with ID ${id} does not exist`);
    }

    if (transfer.status !== "STARTED") {
      throw new Error(
        `Transfer with ID ${transfer.id} has already been processed`,
      );
    }

    await db.transfer.update({
      where: {
        id,
      },
      data: {
        status: "PENDING",
      },
    });

    const share = transfer.share;
    const { destination, configuration } = share;

    if (!configuration) {
      throw new Error(
        `No configuration found for transfer with ID ${transfer.id}, aborting`,
      );
    }

    const view = configuration.view;
    const source = view.source;

    const {
      sourceType: srcDbType,
      host: srcHost,
      port: srcPort,
      username: srcUsername,
      password: srcPassword,
      database: srcDatabase,
    } = source;

    const {
      host: destHost,
      port: destPort,
      username: destUsername,
      password: destPassword,
      database: destDatabase,
      schema: destSchema,
      warehouse: destWarehouse,
    } = destination;

    const sourceConnection = await useConnection({
      dbType: srcDbType,
      host: srcHost,
      port: srcPort,
      username: srcUsername,
      password: srcPassword || undefined,
      database: srcDatabase,
    });

    if (sourceConnection.error) {
      throw new Error(
        `Source with ID ${source.id} is unreachable, aborting transfer ${transfer.id}`,
      );
    }

    const qb = knex({ client: source.sourceType.toLowerCase() });
    const lastModifiedColumn = view.columns.find(
      (col) => col.isLastModified,
    )?.name;

    if (!lastModifiedColumn) {
      throw new Error(
        `Missing lastModified column for configuration ${view.id}`,
      );
    }

    const tenantColumn = view.columns.find((col) => col.isTenantColumn)?.name;

    if (!tenantColumn) {
      throw new Error(`Missing lastModified column for view ${view.id}`);
    }

    const lastModifiedQuery = qb
      .select(lastModifiedColumn)
      .from(view.tableName)
      .where(tenantColumn, "=", share.tenantId)
      .orderBy(lastModifiedColumn, "desc")
      .limit(1)
      .toSQL()
      .toNative();
    const { rows } = await sourceConnection.query(lastModifiedQuery);

    if (!rows[0]) {
      logger.warn(
        lastModifiedQuery,
        "Zero rows returned by lastModified query",
      );

      return db.transfer.update({
        where: { id: transfer.id },
        data: { status: "CANCELLED" },
      });
    }

    const newLastModifiedAt = z
      .string()
      .transform((str) => parseISO(str))
      .or(z.date())
      .parse(rows[0][lastModifiedColumn]);

    const queryDataStream = (
      await sourceConnection.queryStream(
        qb
          .select(
            configuration.columns.map(
              (col) => `${col.nameInSource} as ${col.nameInDestination}`,
            ),
          )
          .from(
            qb
              .select(view.columns.map((col) => col.name))
              .from(view.tableName)
              .as("t"),
          )
          .where(tenantColumn, "=", share.tenantId)
          .where(lastModifiedColumn, ">", share.lastModifiedAt.toISOString())
          .toSQL()
          .toNative(),
      )
    )
      .pipe(
        csv.stringify({
          delimiter: ",",
          header: true,
          bom: true,
        }),
      )
      .pipe(zlib.createGzip());

    switch (destination.destinationType) {
      case "PROVISIONED_S3": {
        const { key } = await uploadObject({
          contents: queryDataStream,
          extension: "gz",
        });

        const objectUrl = await getPresignedURL({ key, extension: "gz" });

        await finalizeTransfer({
          transferId: transfer.id,
          status: "COMPLETE",
          objectUrl,
        });

        break;
      }

      case "SNOWFLAKE": {
        const credentialsExist =
          !!destHost &&
          !!destPort &&
          !!destUsername &&
          !!destPassword &&
          !!destDatabase &&
          !!destSchema;

        if (!credentialsExist) {
          throw new Error(
            `Incomplete credentials for destination with ID ${destination.id}, aborting transfer ${transfer.id}`,
          );
        }

        const destConnection = await useConnection({
          dbType: "SNOWFLAKE",
          warehouse: destWarehouse,
          host: destHost,
          port: destPort,
          username: destUsername,
          password: destPassword,
          database: destDatabase,
          schema: destSchema,
        });

        if (destConnection.error) {
          throw new Error(
            `Destination with ID ${source.id} is unreachable, aborting transfer ${transfer.id}`,
          );
        }

        loader = new SnowflakeLoader(
          destConnection.query,
          share,
          destConnection.queryUnsafe,
        );

        // starting load into Snowflake
        await loader.beginTransaction();

        // table should exist after creating share, but we want to recreate if it doesn't exist
        await loader.createTable({
          schema: destSchema,
          database: destDatabase,
        });

        await loader.stage(queryDataStream, destSchema);
        await loader.upsert(destSchema);
        await loader.tearDown(destSchema);

        // committing load into Snowflake
        await loader.commitTransaction();

        await finalizeTransfer({
          transferId: transfer.id,
          status: "COMPLETE",
        });

        break;
      }
      case "REDSHIFT": {
        const credentialsExist =
          !!destHost &&
          !!destPort &&
          !!destUsername &&
          !!destPassword &&
          !!destDatabase &&
          !!destSchema;

        if (!credentialsExist) {
          throw new Error(
            `Incomplete credentials for destination with ID ${destination.id}, aborting transfer ${transfer.id}`,
          );
        }

        const destConnection = await useConnection({
          dbType: "REDSHIFT",
          host: destHost,
          port: destPort,
          username: destUsername,
          password: destPassword,
          database: destDatabase,
          schema: destSchema,
        });

        if (destConnection.error) {
          throw new Error(
            `Destination with ID ${source.id} is unreachable, aborting transfer ${transfer.id}`,
          );
        }

        loader = new RedshiftLoader(
          destConnection.query,
          share,
          destConnection.queryUnsafe,
        );

        // Starting load into Redshift
        await loader.beginTransaction();

        // table should exist after creating share, but we want to recreate if it doesn't exist
        await loader.createTable({
          schema: destSchema,
          database: destDatabase,
        });

        await loader.stage(queryDataStream);
        await loader.upsert();
        await loader.tearDown();

        // Committing load into Redshift
        await loader.commitTransaction();

        await finalizeTransfer({
          transferId: transfer.id,
          status: "COMPLETE",
        });

        break;
      }
    }

    await db.share.update({
      where: { id: share.id },
      data: { lastModifiedAt: newLastModifiedAt },
    });
  } catch (error) {
    logger.error(error);

    // rollback if loader has been initialized
    await loader?.rollbackTransaction();

    await finalizeTransfer({
      transferId: id,
      status: "FAILED",
    });
  }
}

export async function getWebhooks() {
  return db.webhook.findMany({
    select: { id: true, url: true, secretKey: true },
  });
}

export async function processWebhook({
  transferId,
  webhook,
}: {
  transferId: number;
  webhook: Prisma.WebhookGetPayload<{
    select: { id: true; url: true; secretKey: true };
  }>;
}) {
  try {
    const transfer = await db.transfer.findUnique({
      where: {
        id: transferId,
      },
      select: {
        id: true,
        status: true,
        shareId: true,
        result: {
          select: {
            finalizedAt: true,
            objectUrl: true,
          },
        },
      },
    });

    if (!transfer) {
      throw new Error(`Transfer id not found for Transfer=${transferId}`);
    }

    // todo(ianedwards): increase event type specificity as needed
    const body = {
      type: "transfer.finalized",
      object: transfer,
    };

    await got.post(webhook.url, {
      headers: {
        "X-Pipebird-Signature": crypto
          .createHmac("sha256", webhook.secretKey)
          .update(JSON.stringify(body))
          .digest("hex"),
      },
      json: body,
    });
  } catch (error) {
    logger.error(error);
  }
}
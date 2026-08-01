import crypto from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  getSignedUrl
} from "@aws-sdk/s3-request-presigner";

const MAX_PACKAGE_BYTES =
  96 * 1024 * 1024;

const TEMP_PREFIX =
  "pair-archive-temp/";

function sendJson(
  response,
  status,
  body
) {
  response.statusCode = status;
  response.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );
  response.setHeader(
    "Cache-Control",
    "no-store"
  );
  response.end(
    JSON.stringify(body)
  );
}

function parseBody(request) {
  if (
    typeof request.body ===
      "string"
  ) {
    return JSON.parse(
      request.body
    );
  }

  return request.body || {};
}

function requiredEnvironment() {
  const values = {
    accountId:
      process.env.R2_ACCOUNT_ID,
    accessKeyId:
      process.env.R2_ACCESS_KEY_ID,
    secretAccessKey:
      process.env.R2_SECRET_ACCESS_KEY,
    bucket:
      process.env.R2_BUCKET_NAME
  };

  const missing =
    Object.entries(values)
      .filter(([, value]) =>
        !String(value || "").trim()
      )
      .map(([key]) => key);

  if (missing.length) {
    throw new Error(
      "Vercel의 R2 환경변수가 완성되지 않았습니다."
    );
  }

  return values;
}

function createClient() {
  const env =
    requiredEnvironment();

  const client = new S3Client({
    region: "auto",
    endpoint:
      `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:
        env.accessKeyId,
      secretAccessKey:
        env.secretAccessKey
    }
  });

  return {
    client,
    bucket: env.bucket
  };
}

function isValidTemporaryKey(value) {
  return (
    typeof value === "string" &&
    value.startsWith(
      TEMP_PREFIX
    ) &&
    value.endsWith(".zip") &&
    value.length < 240 &&
    !value.includes("..") &&
    !value.includes("\\")
  );
}

function enforceSameOrigin(request) {
  const origin =
    request.headers.origin;

  if (!origin) return;

  const forwardedHost =
    request.headers[
      "x-forwarded-host"
    ];

  const host =
    String(
      forwardedHost ||
      request.headers.host ||
      ""
    )
      .split(",")[0]
      .trim();

  let originHost = "";

  try {
    originHost =
      new URL(origin).host;
  } catch {
    throw new Error(
      "허용되지 않은 요청 출처입니다."
    );
  }

  if (
    !host ||
    originHost !== host
  ) {
    throw new Error(
      "현재 사이트에서 시작된 요청만 허용됩니다."
    );
  }
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !== "POST" &&
    request.method !== "DELETE"
  ) {
    response.setHeader(
      "Allow",
      "POST, DELETE"
    );

    sendJson(response, 405, {
      error:
        "POST 또는 DELETE 요청만 지원합니다."
    });
    return;
  }

  try {
    enforceSameOrigin(request);

    const body =
      parseBody(request);

    const {
      client,
      bucket
    } = createClient();

    if (
      request.method ===
        "DELETE"
    ) {
      const key = body?.key;

      if (
        !isValidTemporaryKey(key)
      ) {
        throw new Error(
          "삭제할 임시 패키지 경로가 올바르지 않습니다."
        );
      }

      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key
        })
      );

      sendJson(response, 200, {
        deleted: true
      });
      return;
    }

    const size =
      Number(body?.size);

    if (
      !Number.isFinite(size) ||
      size <= 0 ||
      size > MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP은 96MB 이하여야 합니다."
      );
    }

    const key =
      TEMP_PREFIX +
      Date.now() +
      "-" +
      crypto.randomUUID() +
      ".zip";

    const uploadUrl =
      await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType:
            "application/zip"
        }),
        {
          expiresIn: 300
        }
      );

    sendJson(response, 200, {
      key,
      uploadUrl,
      expiresIn: 300,
      maximumSizeInBytes:
        MAX_PACKAGE_BYTES
    });
  } catch (error) {
    console.error(error);

    sendJson(response, 400, {
      error:
        error?.message ||
        "R2 업로드 요청을 준비하지 못했습니다."
    });
  }
}

import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pathToFileURL
} from "node:url";
import chromium from "@sparticuz/chromium";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  unzipSync
} from "fflate";
import puppeteer from "puppeteer-core";

const TEMP_PREFIX =
  "pair-archive-temp/";

const MAX_PACKAGE_BYTES =
  96 * 1024 * 1024;

const MAX_UNPACKED_BYTES =
  300 * 1024 * 1024;

const MAX_ARCHIVE_ENTRIES = 32;

const TEMP_DIRECTORY_PREFIX =
  "pair-archive-";

const STALE_TEMP_MAX_AGE_MS =
  20 * 60 * 1000;

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

  if (
    Object.values(values).some(
      (value) =>
        !String(value || "").trim()
    )
  ) {
    throw new Error(
      "Vercel의 R2 환경변수가 완성되지 않았습니다."
    );
  }

  return values;
}

function createClient() {
  const env =
    requiredEnvironment();

  return {
    client: new S3Client({
      region: "auto",

      endpoint:
        `https://${env.accountId}.r2.cloudflarestorage.com`,

      credentials: {
        accessKeyId:
          env.accessKeyId,

        secretAccessKey:
          env.secretAccessKey
      }
    }),

    bucket: env.bucket
  };
}

async function cleanupStaleTempDirectories() {
  const temporaryRoot =
    os.tmpdir();

  let entries = [];

  try {
    entries = await readdir(
      temporaryRoot,
      {
        withFileTypes: true
      }
    );
  } catch (error) {
    console.warn(
      "임시 폴더 목록을 확인하지 못했습니다.",
      error
    );

    return;
  }

  const now = Date.now();

  await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith(
            TEMP_DIRECTORY_PREFIX
          )
      )
      .map(async (entry) => {
        const target =
          path.join(
            temporaryRoot,
            entry.name
          );

        try {
          const information =
            await stat(target);

          if (
            now -
              information.mtimeMs <
            STALE_TEMP_MAX_AGE_MS
          ) {
            return;
          }

          await rm(
            target,
            {
              recursive: true,
              force: true
            }
          );
        } catch (error) {
          console.warn(
            `오래된 임시 폴더를 정리하지 못했습니다: ${target}`,
            error
          );
        }
      })
  );
}

async function bodyToUint8Array(body) {
  if (!body) {
    throw new Error(
      "R2에서 렌더 ZIP을 읽지 못했습니다."
    );
  }

  if (
    typeof body.transformToByteArray ===
      "function"
  ) {
    return new Uint8Array(
      await body.transformToByteArray()
    );
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of body) {
    const buffer =
      Buffer.from(chunk);

    total += buffer.length;

    if (
      total >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    chunks.push(buffer);
  }

  return new Uint8Array(
    Buffer.concat(chunks)
  );
}

function safeEntryPath(
  root,
  name
) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(
      "렌더 ZIP에 올바르지 않은 파일 경로가 있습니다."
    );
  }

  const normalized =
    path.posix.normalize(name);

  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(
      normalized
    )
  ) {
    throw new Error(
      "렌더 ZIP의 파일 경로를 사용할 수 없습니다."
    );
  }

  const destination =
    path.resolve(
      root,
      normalized
    );

  const rootPrefix =
    path.resolve(root) +
    path.sep;

  if (
    destination !==
      path.resolve(root) &&
    !destination.startsWith(
      rootPrefix
    )
  ) {
    throw new Error(
      "렌더 ZIP의 파일 경로를 사용할 수 없습니다."
    );
  }

  return destination;
}

async function extractPackage(
  zipBytes,
  root
) {
  const files =
    unzipSync(zipBytes);

  const entries =
    Object.entries(files);

  if (
    entries.length < 1 ||
    entries.length >
      MAX_ARCHIVE_ENTRIES
  ) {
    throw new Error(
      "렌더 ZIP의 파일 수가 허용 범위를 벗어났습니다."
    );
  }

  if (!files["index.html"]) {
    throw new Error(
      "렌더 ZIP에서 index.html을 찾지 못했습니다."
    );
  }

  let total = 0;

  for (const [name, bytes] of entries) {
    const allowed =
      name === "index.html" ||
      name.startsWith(
        "images/"
      );

    if (!allowed) {
      throw new Error(
        "렌더 ZIP에 허용되지 않은 파일이 포함돼 있습니다."
      );
    }

    total += bytes.byteLength;

    if (
      total >
      MAX_UNPACKED_BYTES
    ) {
      throw new Error(
        "압축을 푼 렌더 자료가 300MB를 넘습니다."
      );
    }

    const destination =
      safeEntryPath(
        root,
        name
      );

    await mkdir(
      path.dirname(destination),
      {
        recursive: true
      }
    );

    await writeFile(
      destination,
      bytes
    );
  }

  return path.join(
    root,
    "index.html"
  );
}

export default async function handler(
  request,
  response
) {
  if (
    request.method !== "POST"
  ) {
    response.setHeader(
      "Allow",
      "POST"
    );

    sendJson(
      response,
      405,
      {
        error:
          "POST 요청만 지원합니다."
      }
    );

    return;
  }

  const body =
    parseBody(request);

  const key =
    body?.key;

  if (!isValidTemporaryKey(key)) {
    sendJson(
      response,
      400,
      {
        error:
          "렌더링할 임시 ZIP 경로가 올바르지 않습니다."
      }
    );

    return;
  }

  const width = Math.max(
    900,
    Math.min(
      1800,
      Number(body?.width) ||
        1440
    )
  );

  const scale = Math.max(
    1,
    Math.min(
      3,
      Number(body?.scale) ||
        2
    )
  );

  let browser = null;
  let page = null;
  let tempDirectory = "";
  let client = null;
  let bucket = "";

  try {
    /*
     * 이전 함수 실행이 강제 종료되어
     * finally가 실행되지 않았을 경우 남아 있는
     * 오래된 임시 폴더를 먼저 정리합니다.
     */
    await cleanupStaleTempDirectories();

    ({
      client,
      bucket
    } = createClient());

    const object =
      await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key
        })
      );

    if (
      Number(
        object.ContentLength || 0
      ) >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    const zipBytes =
      await bodyToUint8Array(
        object.Body
      );

    if (
      zipBytes.byteLength >
      MAX_PACKAGE_BYTES
    ) {
      throw new Error(
        "렌더 ZIP이 96MB를 넘습니다."
      );
    }

    /*
     * 이번 요청에서만 사용하는
     * 고유 임시 작업 폴더를 생성합니다.
     */
    tempDirectory =
      await mkdtemp(
        path.join(
          os.tmpdir(),
          TEMP_DIRECTORY_PREFIX
        )
      );

    const siteDirectory =
      path.join(
        tempDirectory,
        "site"
      );

    const chromiumProfileDirectory =
      path.join(
        tempDirectory,
        "chromium-profile"
      );

    const chromiumCacheDirectory =
      path.join(
        tempDirectory,
        "chromium-cache"
      );

    const chromiumConfigDirectory =
      path.join(
        tempDirectory,
        "chromium-config"
      );

    const chromiumTempDirectory =
      path.join(
        tempDirectory,
        "chromium-temp"
      );

    /*
     * HTML과 이미지뿐 아니라 Chromium이 만드는
     * 프로필, 캐시, 설정, 임시 파일까지
     * 모두 같은 작업 폴더 안에 넣습니다.
     *
     * 마지막에 tempDirectory 하나만 지우면
     * Chromium 관련 찌꺼기도 함께 삭제됩니다.
     */
    await Promise.all([
      mkdir(
        siteDirectory,
        {
          recursive: true
        }
      ),

      mkdir(
        chromiumProfileDirectory,
        {
          recursive: true
        }
      ),

      mkdir(
        chromiumCacheDirectory,
        {
          recursive: true
        }
      ),

      mkdir(
        chromiumConfigDirectory,
        {
          recursive: true
        }
      ),

      mkdir(
        chromiumTempDirectory,
        {
          recursive: true
        }
      )
    ]);

    const indexPath =
      await extractPackage(
        zipBytes,
        siteDirectory
      );

    const executablePath =
      await chromium.executablePath();

    browser =
      await puppeteer.launch({
        args: [
          ...chromium.args,

          "--allow-file-access-from-files",

          /*
           * Chromium이 디스크 캐시를 크게 만들지 않도록
           * 캐시 기능을 최대한 제한합니다.
           */
          "--disable-application-cache",
          "--disk-cache-size=0",
          "--media-cache-size=0",

          /*
           * 혹시 생성되는 캐시도 모두
           * 현재 요청의 작업 폴더 안으로 보냅니다.
           */
          `--disk-cache-dir=${chromiumCacheDirectory}`
        ],

        defaultViewport: {
          width,
          height: 1200,

          /*
           * 기존 저장 배율을 그대로 유지합니다.
           * 기본값은 2배이므로 화질은 낮아지지 않습니다.
           */
          deviceScaleFactor:
            scale
        },

        /*
         * Chromium이 사용하는 HOME과 임시 경로를
         * 현재 작업 폴더 내부로 강제합니다.
         */
        env: {
          ...process.env,

          HOME:
            tempDirectory,

          TMPDIR:
            chromiumTempDirectory,

          XDG_CACHE_HOME:
            chromiumCacheDirectory,

          XDG_CONFIG_HOME:
            chromiumConfigDirectory
        },

        executablePath,

        headless:
          chromium.headless,

        /*
         * Chromium 사용자 프로필도 작업 폴더 내부에 생성합니다.
         */
        userDataDir:
          chromiumProfileDirectory
      });

    page =
      await browser.newPage();

    /*
     * 페이지 단위 캐시도 비활성화합니다.
     */
    await page.setCacheEnabled(
      false
    );

    await page.setExtraHTTPHeaders({
      "Accept-Language":
        "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
    });

    await page.setViewport({
      width,
      height: 1200,
      deviceScaleFactor:
        scale
    });

    await page.goto(
      pathToFileURL(
        indexPath
      ).href,
      {
        waitUntil: [
          "domcontentloaded",
          "networkidle0"
        ],

        timeout:
          60_000
      }
    );

    /*
     * 웹폰트와 업로드한 이미지가 모두 준비된 뒤
     * PNG를 생성합니다.
     */
    await page.evaluate(async () => {
      if (document.fonts) {
        await Promise.allSettled([
          document.fonts.load(
            '400 16px "Noto Sans KR"',
            "한글 漢字"
          ),

          document.fonts.load(
            '700 16px "Noto Sans KR"',
            "한글 漢字"
          ),

          document.fonts.load(
            '900 16px "Noto Sans KR"',
            "한글 漢字"
          )
        ]);

        await document.fonts.ready;
      }

      await Promise.all(
        Array.from(
          document.images
        ).map(async (image) => {
          try {
            if (
              typeof image.decode ===
                "function"
            ) {
              await image.decode();
            }
          } catch {
            /*
             * 일부 이미지의 decode가 실패하더라도
             * 전체 렌더링은 계속 진행합니다.
             */
          }
        })
      );

      /*
       * 레이아웃 계산이 완전히 끝나도록
       * 두 번의 프레임을 기다립니다.
       */
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(
            resolve
          );
        });
      });
    });

    const dimensions =
      await page.$eval(
        "#captureArea",
        (element) => ({
          width: Math.ceil(
            element
              .getBoundingClientRect()
              .width
          ),

          height: Math.ceil(
            element.scrollHeight
          )
        })
      );

    await page.setViewport({
      width:
        dimensions.width,

      height: Math.max(
        900,
        Math.min(
          8000,
          dimensions.height
        )
      ),

      deviceScaleFactor:
        scale
    });

    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(
              resolve
            );
          });
        })
    );

    const target =
      await page.$(
        "#captureArea"
      );

    if (!target) {
      throw new Error(
        "저장 영역을 찾지 못했습니다."
      );
    }

    /*
     * path 옵션을 사용하지 않고
     * PNG 자체를 메모리 Buffer로 받습니다.
     *
     * 따라서 뒤에서 임시 폴더를 삭제해도
     * 완성된 PNG는 사라지지 않습니다.
     */
    const png =
      await target.screenshot({
        type: "png",
        omitBackground: false,
        captureBeyondViewport: true
      });

    const pngBuffer =
      Buffer.isBuffer(png)
        ? png
        : Buffer.from(png);

    response.statusCode =
      200;

    response.setHeader(
      "Content-Type",
      "image/png"
    );

    response.setHeader(
      "Content-Disposition",
      'inline; filename="pair-archive.png"'
    );

    response.setHeader(
      "Cache-Control",
      "no-store"
    );

    response.setHeader(
      "Content-Length",
      String(
        pngBuffer.byteLength
      )
    );

    /*
     * PNG 데이터가 메모리에 완성된 상태에서
     * 사용자에게 바로 전송합니다.
     */
    response.end(
      pngBuffer
    );
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      sendJson(
        response,
        500,
        {
          error:
            error?.message ||
            "Chromium 렌더링 중 오류가 발생했습니다."
        }
      );
    } else {
      response.end();
    }
  } finally {
    /*
     * PNG 생성 성공 여부와 관계없이
     * 페이지를 먼저 닫습니다.
     */
    if (page) {
      try {
        await page.close({
          runBeforeUnload: false
        });
      } catch (error) {
        console.warn(
          "렌더 페이지를 닫지 못했습니다.",
          error
        );
      }
    }

    /*
     * Chromium 프로세스를 종료합니다.
     * PNG 데이터는 이미 Buffer로 생성됐기 때문에
     * 브라우저를 닫아도 다운로드에는 영향이 없습니다.
     */
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.warn(
          "Chromium을 종료하지 못했습니다.",
          error
        );
      }
    }

    /*
     * ZIP 압축 해제 파일, Chromium 프로필,
     * 캐시, 설정, 임시 파일이 들어 있는
     * 전체 작업 폴더를 삭제합니다.
     */
    if (tempDirectory) {
      try {
        await rm(
          tempDirectory,
          {
            recursive: true,
            force: true
          }
        );
      } catch (error) {
        console.warn(
          "임시 렌더 폴더를 정리하지 못했습니다.",
          error
        );
      }
    }

    /*
     * R2에 잠시 올려 둔 ZIP 파일도 삭제합니다.
     */
    if (client && bucket) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key
          })
        );
      } catch (error) {
        console.warn(
          "R2 임시 ZIP 삭제에 실패했습니다.",
          error
        );
      }
    }
  }
}

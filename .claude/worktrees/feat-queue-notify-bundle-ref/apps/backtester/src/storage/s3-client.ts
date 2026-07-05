// S3-compatible object-store port. The adapters depend ONLY on this interface, never on AWS SDK
// types. @aws-sdk/client-s3 is imported at runtime through a WIDENED specifier so it is not a
// compile-time dependency and the same client speaks to any S3-compatible endpoint (MinIO, AWS, …).

export interface S3ObjectClient {
  /** Idempotent — key is a content hash, so identical bytes overwrite the identical object. */
  put(key: string, body: string): Promise<void>;
  /** Resolves to undefined when the object is absent. */
  get(key: string): Promise<string | undefined>;
  head(key: string): Promise<boolean>;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

// Widened to `string` so TypeScript does not resolve the module type at compile time.
const S3_SPECIFIER: string = '@aws-sdk/client-s3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNotFound(err: any): boolean {
  return err?.name === 'NoSuchKey' || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

export async function createS3ObjectClient(cfg: S3Settings): Promise<S3ObjectClient> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aws: any;
  try {
    aws = await import(S3_SPECIFIER);
  } catch {
    throw new Error(
      "store backend 's3' requires @aws-sdk/client-s3 to be installed (pnpm add @aws-sdk/client-s3)",
    );
  }
  const s3 = new aws.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? 'us-east-1',
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async put(key, body) {
      await s3.send(new aws.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body }));
    },
    async get(key) {
      try {
        const r = await s3.send(new aws.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return (await r.Body.transformToString()) as string;
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },
    async head(key) {
      try {
        await s3.send(new aws.HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },
  };
}

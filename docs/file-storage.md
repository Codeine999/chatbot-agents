# File storage (uploads)

Every uploaded file goes through `FileStorageService` (`src/infra/storage`).
Features never write to disk or to a bucket themselves.

| Feature | Folder | Visibility | Column |
|---|---|---|---|
| Admin profile picture | `admin_profile_image` (legacy rows: `admin`) | public | `adminMember.image` |
| Company logo | `company` | public | `company.image` |
| Rich menu image | `richmenu` | public | `richMenuTemplate.imagePath` |
| Rich menu cell artwork | `richmenu/cells` | public | `richMenuTemplate.cellImages[].path` |
| Top-up payment slip | `billing` | **private** | `creditTopupHistory.slipImage` |

## Drivers

`STORAGE_DRIVER` selects where **new** files go:

- `local` (default): `uploads/<folder>/<uuid>.<ext>`, served by `@fastify/static`
  at `/uploads/...`. It has no private area, so slips are public, as they were
  before R2.
- `r2`: Cloudflare R2 through its S3 API.

Reads, deletes and URLs follow the stored reference, not the driver. Rows
written before a switch keep working, and `/uploads/...` stays served.

## Stored references

| Reference in the DB | Meaning | What the API returns |
|---|---|---|
| `/uploads/admin/<uuid>.png` | local disk (legacy or `local` driver) | as stored |
| `https://<R2_PUBLIC_URL>/admin_profile_image/<uuid>.png` | R2 public bucket | as stored |
| `r2-private:billing/<uuid>.jpg` | R2 private bucket | signed URL, valid `R2_SIGNED_URL_TTL_SECONDS` |

The bill endpoints (`top-up`, `confirm`, `reject`, `history`) replace
`slipImage` with that URL. A private reference is never sent to the client.

## R2 setup

R2 sets public access per bucket, not per object, so it needs two buckets:

1. **Private bucket** for slips. Keep public access off.
2. **Public bucket** for images. Enable its r2.dev URL or attach a custom
   domain.
3. Create an R2 API token with *Object Read & Write* on both buckets.

```env
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=<32 hex chars, from https://<ACCOUNT_ID>.r2.cloudflarestorage.com>
R2_ACCESS_KEY_ID=<token access key id>
R2_SECRET_ACCESS_KEY=<token secret>
R2_BUCKET=<private bucket>
R2_PUBLIC_BUCKET=<public bucket>
R2_PUBLIC_URL=https://files.example.com   # r2.dev or custom domain of the public bucket
R2_SIGNED_URL_TTL_SECONDS=900             # optional, 1..604800
```

Settings are read on first use, so the app boots without them. Uploads then
fail with 503 `File storage is not configured`.

## Rules

- Storage calls are network calls under R2, so none run inside a database
  transaction. Rich menu uploads the file before taking the template row lock.
  It composites against an unlocked snapshot, then swaps `imagePath` under the
  lock only if the cells still match. Old files are deleted after commit.
- `read`/`remove` take the owning folder and refuse anything else. A reference
  copied from another feature can't be read or deleted, and crafted paths
  (`..`) are rejected.
- Deletes are best effort. A failed delete is logged and leaves an orphan
  object, never a failed request.
- Existing `/uploads/...` files are not copied to R2. Legacy slips stay
  publicly reachable until they are migrated or removed.

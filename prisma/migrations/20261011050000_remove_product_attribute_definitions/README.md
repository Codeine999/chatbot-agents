Field metadata now comes exclusively from BUSINESS_PRESETS in code. The former
custom-definition create/update endpoints are removed. Preset listing/apply and
selected field listing keep their existing routes; apply returns fields rather
than created/activated/archived definition rows. Historical command results are
preserved for idempotent replay.

Before deploying, export productAttributeDefinitions and company business choice
to a private backup outside the repository. This migration deliberately removes
definition rows and their enums. It preserves every product, variant, detail row,
inventory record, JSON value and catalog command. Unknown historical JSON is not
searchable or AI-visible and cannot be newly written via catalog APIs.

Category restrictions are moved to Company.productPresetCategories, using the
union of active preset-managed categories. The app uses the selected code preset
for form fields, validation, planner, embedding and AI evidence. All product
search revisions advance so the existing index worker rebuilds derived vectors.

Rollback requires a new forward migration recreating the table/enums from the
preceding migration definitions, restoring the exported rows, and deploying the
preceding application. Retain productPresetCategories until restored rows are
verified, and increment searchRevision again; never decrement revisions.

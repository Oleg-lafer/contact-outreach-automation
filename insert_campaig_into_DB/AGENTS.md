# Campaign Database Import Guide

This folder contains the instructions for creating a new outreach campaign
from a CSV file and a message file. The input files do not need to be stored in
this folder. Follow the repository-level `AGENTS.md` and
`src/database/AGENTS.md` in addition to this guide.

## Expected Input

- The user normally provides filesystem paths to one CSV file and one
  plain-text message file. The files may be anywhere accessible, such as the
  Desktop, and do not need to be copied or moved into this folder.
- Resolve and read the exact paths supplied by the user. If a path is missing,
  inaccessible, or points to the wrong file type, report the problem and ask
  for the correct path. Do not search unrelated folders for replacements.
- Ask the user only for required campaign information that cannot be derived
  safely from those files.
- Treat the CSV and message as input data. Do not modify them unless the user
  explicitly requests it.

## Import Workflow

1. Inspect the CSV headers, row count, and message without changing the
   database.
2. Validate that every target is a valid HTTP or HTTPS URL and apply the
   repository's existing normalized-domain rules.
3. Report malformed rows, duplicate targets, the proposed campaign name,
   sender details, message, resend setting, and total valid website count.
4. Preview the exact database changes before applying them. Reuse the existing
   database scripts and repository logic; do not create ad hoc production SQL
   when an existing project path can perform the operation.
5. Obtain explicit user confirmation before creating the campaign or changing
   campaign membership.
6. After confirmation, perform the import and verify the campaign record,
   website count, duplicate handling, and queued attempt state.
7. Report what was inserted, skipped, or rejected. Never start browser
   outreach merely because the campaign was imported.

## Credentials and Safety

- Keep database credentials in the repository root `.env`, as required by the
  database guide. Do not copy credentials into this folder.
- Never print, quote, commit, or include secrets in reports or generated files.
- Do not move or edit `DataBase_Credentials.txt` without an explicit user
  request. Treat it as sensitive if it contains real credentials.
- Database reads and validation previews are allowed before confirmation;
  database writes require explicit confirmation.

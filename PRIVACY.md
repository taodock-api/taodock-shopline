# Data handling

This is the data flow of the self-hosted Taodock Catalog Review app. Your hosting environment and its operator control where the app runs and who can use it.

- The server uses your private SHOPLINE app token to read product identifiers, titles, SPUs, status and descriptions. It sends a new HTML description back to SHOPLINE when you confirm a checked draft.
- Generation sends the selected product title, approved measurements, required phrases, chosen model ID and a fixed instruction to `https://taodock.com/v1/chat/completions`. The configured Taodock key authenticates this request and the model list request. The current description and product identifiers are kept out of the generation request.
- The app holds drafts, findings and previewed descriptions in process memory. Reviews expire after an hour. Expired reviews are cleared when new drafts are generated, and restarting the server clears all reviews. The app has no analytics or tracking code.
- Flagging records the time, product ID, draft revision and chosen reason in `.taodock-data/flags.jsonl` by default. The app stores this log locally for the operator to review. The operator controls how long to retain it. It does not include submitted facts or draft text.
- Keep SHOPLINE, Taodock and app access credentials in the host environment or secret manager. The frontend does not receive these credentials. Use HTTPS for remote access.

[Questions and bug reports](https://github.com/taodock-api/taodock-shopline/issues) · [Taodock API documentation](https://docs.taodock.com/en/api/overview.html)

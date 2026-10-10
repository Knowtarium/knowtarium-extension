# Security

The Knowtarium Web Clipper signs and encrypts what you save before it leaves your browser, and it
can only add clips to your workspace: it holds no key that reads your notes. This repository is
the extension's whole code, so reports about it matter to us. How Knowtarium protects your data:
[knowtarium.com/security](https://knowtarium.com/security).

## Reporting a vulnerability

Please report it privately, never in a public issue: email support@knowtarium.com, with
"Security" in the subject.

Include what you found, how to reproduce it, and the extension's version (shown on the browser's
extensions page). We answer within a few working days, keep you posted while we fix it, and
credit you in the release notes if you'd like.

## Known limits

- **A copied browser profile.** Someone who copies your browser profile gets the extension's
  token and signing key. They can add clips to your inbox until you disconnect the extension or
  remove it in your workspace's settings; they can't read anything.
- **The pairing code protects you only if you compare it.** Allow a connection in Knowtarium
  only when it shows the code your extension shows, right after you clicked Connect.
- **A server that hides a new inbox key.** After a key rotation, a server could keep the
  extension on the older inbox key until you connect it again.

## Supported versions

Only the latest version in the Chrome Web Store and Edge Add-ons gets security fixes; browsers
update extensions automatically.

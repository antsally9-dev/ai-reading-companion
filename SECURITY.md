# Security policy

Please report security issues privately through GitHub Security Advisories after the repository is published. Do not include API keys, private notes, or other sensitive Vault data in a public issue.

The plugin stores only the Obsidian SecretStorage key name in plugin settings. The secret value is read at request time and sent only to the API base URL configured by the user.

# Verify Response

Send a prompt to one provider, then have a **different provider check the answer**.

![Verify Response screenshot](assets/docs/images/verify.png)

## When to use it

- Catching hallucinations on factual claims.
- Spotting numeric mistakes in financial or scientific answers.
- Detecting biased or one-sided framings.

## Example

Send a financial question to OpenAI, then have DeepSeek verify whether the figures are accurate.

## How it works

The verifier's answer streams next to the original response so you can compare both at a glance. The verifier is given the original prompt **and** the response to check, and asked to flag any issues.

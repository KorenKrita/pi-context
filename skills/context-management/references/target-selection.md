# Target Selection

Use when you know you need to travel but can't identify the right target.

## Finding the target

1. Use `acm_timeline({ view: "checkpoints" })` to see saved bookmarks
2. Use `acm_timeline({ view: "search", query: "keyword" })` to find specific entries
3. Use `acm_timeline({ view: "tree" })` to see branch structure

## Rules

- Pick the last clean point **before** the material you're folding
- Don't pick a point inside the range you're folding
- A node ID from timeline output is a valid target
- `root` targets the very beginning — use only for full rebases

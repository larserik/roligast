# Roligast

A site for the funniest things on the internet: jokes, clips, pictures and links
that anyone can add and anyone can rate from 1 to 10.

- **Nobody has to sign in.** Posting and rating both work signed out. Signing in
  is by email only: type your address, get a six-digit code, type it in. There
  are no passwords, and an account is created the first time an address is used.
- **Two languages.** Swedish and English, switched from the header. The choice is
  kept in a cookie, and a first-time visitor gets whichever their browser asks
  for.
- **Nothing is uploaded.** A post is a title, some text, a link, or a
  combination. Links to YouTube, Vimeo, TikTok, Instagram, Streamable and Imgur -
  and direct links to an image or a video file - are shown right on the page.

## Running it

```sh
cp .env-example .env      # SMTP details for the sign-in codes
docker compose up -d --build
```

The container binds no ports on the host. It only *exposes* port 3000 on the
`nginx-network` docker network, where the reverse proxy reaches it as
`http://roligast:3000`. Locally, browse to the container's own address:

```sh
docker inspect roligast --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
# -> 172.20.0.15, so http://172.20.0.15:3000
```

`nginx-network` has to exist already; it is created by the nginx stack, and
compose treats it as external.

Without docker, `npm install && npm start` runs it on port 3000 with the
database in `./data`.

### Environment

| Variable | Meaning |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM` | Where sign-in codes are sent from. **Leave `SMTP_HOST` empty and the code is written to the container log instead**, which is how to sign in during development. |
| `DATABASE_PATH` | SQLite file. `/data/roligast.db` in the image, on the `roligast-data` volume. |
| `PORT` | Defaults to 3000. |

## How it fits together

```
src/
  server.js   routes and the express setup
  db.js       the SQLite schema, created on start
  auth.js     one-time codes, sessions, the sign-in middleware
  ratings.js  rating a post, and the score the top list is sorted by
  embed.js    what a pasted link is, and how to show it
  i18n.js     the Swedish and English dictionaries
  mailer.js   the sign-in code email
  views/      EJS templates
  public/     stylesheet, a little progressive-enhancement JavaScript, the logo
```

Everything works without JavaScript: rating is an ordinary form post that
redirects back. With it, a rating updates in place and a pasted sign-in code
submits itself.

### Who rated what

Signed out, a rating belongs to a random id in the `visitor` cookie - enough to
keep one browser from rating the same post ten times. Signed in, it belongs to
the account, and whatever the browser rated before signing in moves over to the
account at that moment. That is also why someone can delete a post they added
before signing in.

### The top list

A post's rank is its average pulled towards the middle while it has few votes
(five imagined votes of 5.5). Without that a single 10 from whoever posted it
would top the list. *Hot* is the same score faded as the post ages, roughly
halved after three days.

### Remembering an email address

"Remember my email on this device" (ticked by default) stores the address in its
own long-lived cookie, separate from the session. Signing out leaves the login
form filled in; unticking it clears the cookie.

## Notes

- The real SMTP password lives only in `.env`, which `.gitignore` keeps out of
  the repo. `.env-example` has an empty `SMTP_PASS` on purpose - keep it that
  way.
- Posts and ratings are not moderated. Since anyone can post, the only limit is
  ten posts per hour per visitor.

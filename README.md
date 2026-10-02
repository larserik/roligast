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
  network.js  the Tor exit list and reverse DNS, neither in the request path
  tracking.js who a visitor is, what they loaded and what they did on it
  views/      EJS templates
  public/     stylesheet, a little progressive-enhancement JavaScript, the logo
scripts/
  logins.js   reads the sign-in log; runs inside the container
  logins.sh   the same thing, without typing the docker part
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

## Watching sign-ins

`login_pins` holds only codes that are still live - a row is deleted the moment
its code is used and pruned once it expires - so it is no use for seeing who has
been asking. `login_events` is the record: one row per step. The events are
`invalid_email`, `throttled`, `requested`, `sent`, `send_failed`, `wrong_code`,
`expired`, `too_many` and `verified`.

Each row also carries what the request itself gave away: the referer, the
`Accept-Language` header, whether it arrived with the `visitor` cookie this site
hands out on any page load, the address's reverse DNS name, and `network = 'tor'`
when the address is on the Tor Project's published exit list (refreshed every six
hours; a failed refresh keeps the previous list). The reverse lookup happens
after the row is written, so nobody waits on it.

The cookie and the referer were meant to tell a browser from a script, and for a
while they did. The traffic then started arriving with both, so on their own they
prove nothing; what it has not managed to fake is its `User-Agent`, which arrives
wrapped in literal double quotes. No browser does that. `bots` looks for any of
those signals together with Tor membership.

Rows written before these columns existed show `?` rather than `NO`, and count as
`not recorded` rather than `ordinary`, because never having been asked is not the
same as having answered no. `enrich` fills in the network and reverse DNS for
them after the fact, from the address alone - it only ever marks an address as
Tor, never as ordinary, since an address missing from today's exit list may still
have been one when the request arrived.

`scripts/logins.sh` reads it in the running container:

```sh
./scripts/logins.sh                  # everything at a glance, last 7 days
./scripts/logins.sh ips 30           # where the traffic came from
./scripts/logins.sh unverified 0     # sent a code, never signed in, all time
./scripts/logins.sh email a@b.se     # everything for one address
./scripts/logins.sh ip 45.9.148.99   # everything from one client
./scripts/logins.sh daily            # day by day, for spotting a burst
./scripts/logins.sh bots             # Tor, quoted user agents, missing cookie
./scripts/logins.sh networks         # how much came over Tor
./scripts/logins.sh full 30          # every column, last 30 events
./scripts/logins.sh show 25          # one event, every field, untruncated
./scripts/logins.sh enrich           # backfill network and rdns on older rows
./scripts/logins.sh size             # rows, bytes, how fast it is growing
./scripts/logins.sh help             # the rest
```

Pass `0` for days to mean all time. Against a database on this machine rather
than in the container, run the same commands as
`DATABASE_PATH=./data/roligast.db node scripts/logins.js ...`.

One IP with many addresses and no `verified` is the shape to watch for: the
sign-in form will mail a code to any address submitted, and every bounce from a
dead address is charged against the sending reputation of `info@roligast.com`.
There is still no per-IP limit on requesting a code - the log is there to show
what the limit should be.

**Nothing deletes these events.** A row costs about 400 bytes with its indexes,
measured over 100,000 of them, so a million is around 380 MB. `size` reports what
the table is holding and projects the current rate forward. If it ever does need
cutting back, that is a decision to take by hand:

```sh
./scripts/logins.sh prune 365          # says how many would go, deletes nothing
./scripts/logins.sh prune 365 --yes    # actually deletes, then vacuums
```

`req.ip` is the address nginx saw, because `trust proxy` counts one hop rather
than trusting the whole `X-Forwarded-For` chain (with `true`, Express takes the
leftmost entry, which the client writes). If every row shows the same `172.x`
address, nginx is not passing `X-Forwarded-For` and its `proxy_set_header` needs
fixing before the column means anything.


## Following a visitor

Three tables record a journey. `visitors` is written once per browser and holds
how they arrived: the page they landed on, the referer that sent them, their
address and its reverse DNS, and the whole header set of that first request.
`page_views` has every page the server rendered for them, in order.
`visitor_events` has what the browser reported from inside those pages - which
links were clicked, how far it scrolled, which field was being filled and how,
and every URL the page loaded.

```sh
./scripts/logins.sh visitors         # everyone who loaded a page, newest first
./scripts/logins.sh journey 5b11658b # one of them, entry headers and every step
```

A journey merges all three sources plus the sign-in log into one timeline, so a
visit reads straight through: arrived from Google, loaded these files, scrolled
half way, clicked a rating, asked for a code, signed in.

**No field reports its value unless the page says it may.** A field always
reports its shape - how many characters, how many keystrokes, how many of those
were deleting, whether it was pasted or filled in without typing, and the pause
before each keystroke in milliseconds. The value itself is recorded only from a
field carrying `data-track-value`, which is on the display name and the fields
of the add form, all of which are about to be published anyway. The email box
and the code box do not carry it, and `track.js` refuses a field whose type or
name looks like an address, a code or a password even if the attribute ever
appears on one by mistake. Cookies are left out of the stored header set for the
same reason, since the session token is among them.

The keystroke gaps are also the honest version of telling a person from a
script. The same four characters, typed and set:

```
"test"  8 keys (2 deleting)  over 4.9s  gaps 115 235 129 259 485 205 156 ms (median 205ms)
"test"  0 keys  FILLED WITHOUT TYPING   over 5.8s
```

The caps are in `src/tracking.js`: 200 events per batch, 2000 page views and
5000 events per visitor. `size` reports what these tables hold alongside the
sign-in log. They grow faster than it does, so they are the ones to watch.

## Notes

- The real SMTP password lives only in `.env`, which `.gitignore` keeps out of
  the repo. `.env-example` has an empty `SMTP_PASS` on purpose - keep it that
  way.
- Posts and ratings are not moderated. Since anyone can post, the only limit is
  ten posts per hour per visitor.

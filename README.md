# superteamawesome
MIT ATS Mystery Hunt Puzzle Organizer

Before you can do anything, you'll need a config.js file with Google Auth and your database connection information. Look at `config.js.example` or email styu314@gmail.com for a sample. You'll also need to enable the Google Drive, URL Shortener, and Google+ APIs in your [Project console](https://console.developers.google.com/project).

**Quick setup for those with a Mac and MAMP installed:**

Run the following commands:

```
./setup.sh
./run.sh
```

**Extended setup or for those with non macs or non MAMP-installers:**

To run, first run `npm install` (may need `sudo`), and then run `npm start`.
You might need to install nodemon (`npm install --global nodemon`) first.

To dev, you'll need to install gulp (`npm install --global gulp`) and run `gulp` to compile the scss files

`npm start` will auto compile the jsx and bundle all the js into a bundle.js in public/js

Navigate to http://localhost:8080/!

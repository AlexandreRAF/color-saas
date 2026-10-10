# Project Stack
## Frontend
- HTML
- CSS
- JavaScript
- React (only on the main color application)
## Backend
- Node JS
- Expess.js
- MySQL
# User Authentication
- JWT + e-mail code
- E-mail + password required only
- Multiple session allowed
- Session expires in 14 days (should be configurable via the .env file), and should be kept on the database, even if the server is rebooted.
# User Authorization
- Each user will have a number of credits, each representing one query on the AI researcher
- Users with no credits should not be able to query the AI
- New users are given 3 free credits once they create the account
# Stored Data
- AI query results should be all saved into a database.
- These results will be kept assigned to the users that made it for 7 days (configurable trough the .env), for history purposes, then anonymized and unassigned from the users.
- Data handling should follow Brazil's ANPD guidelines and rules, as the website target country is Brazil.
# AI query handling
- Queries should go to a queue with at most 4 concurrent AI queries
- Queries that finish with an error and do not return any result should not lower user credits
- Queries that finish with an no colors found error should be an exception, and these should be propperly handled and should discount user credits
# Frontend details
- Pages such as home, policies, and about should use plain html
- The main app should use React
# The App
- It should have a page with all the fields needed to make the ai query
- After a query is made, it should keep getting the status of the agentic loop, to give feedback to the user while the AI is working. This loading menu should show the number of sucessfully fetched pages, and browser uses. Also, it should show the number of AI workers called during the loop
- After the query is done, it should show the extracted colors in a table format, mentioning the sources of each, and putting them in confidence order, based on the number of sources and other available information on the query result.
- It should have a page to see the query history
- Each query should have an unique id, that can be accessed via url by the user while it is on its history. Queries must only be accessed by the users who made it, and if it is still on their limited history.
# Credit Purchase
- Credits will be purchased trough credit packs, and will be paid with Stripe payment gateway.
- Users may receive a feedback when their credits are running low, asking them to buy credits.
- Credit payment should be handled propperly, and user personal data should never be stored on the server.
# Safety
- User inputs that goes to the AI must be sanitized, and must be free of prompt injection, both front end side and back end side.
- Do the best practices to avoid SQL injection, cross site scripting attacks, DDOS attacks, brute force attacks (specially on user login), and other kinds of security problems that may put the server or user data at risk.
- **This will be a mission critical application, so it must be stable and safe.**
- Any kind of user input that reaches the server must be sanitized and validated both client side and server side.


const request = require("supertest");
const app = require("../service");
const { DB, Role } = require("../database/database.js");
const config = require("../config.js");
const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
const testAdmin = { name: "admin", email: "admin@test.com", password: "admin" };

const dbHost = config.db.connection.host;
if (!["127.0.0.1", "localhost"].includes(dbHost)) {
  throw new Error(
    `Refusing to run tests against non-local database host: ${dbHost}`,
  );
  //claude recommended this and I actually think its a great idea
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

let testUserId;
let testAdminAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserId = registerRes.body.user.id;

  testAdmin.email = Math.random().toString(36).substring(2, 12) + "@admin.com";
  await DB.addUser({ ...testAdmin, roles: [{ role: Role.Admin }] });
  const adminRes = await request(app).put("/api/auth").send(testAdmin);
  testAdminAuthToken = adminRes.body.token;
});

//happy path 200
test("delete user", async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUserId}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ deleted: true });

  //the deleted user shouldn't be able to log in anymore
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(404);
  expect(loginRes.body.message).toBe("unknown user");

  //fix it
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserId = registerRes.body.user.id;
});

//happy path 200
test("delete user", async () => {
  const deleteRes = await request(app)
    .delete(`/api/user/${testUserId}`)
    .set("Authorization", `Bearer ${testAdminAuthToken}imabaddie`);

  expect(deleteRes.status).toBe(401);
  expect(deleteRes.body).toEqual({ message: "unauthorized" });

  //the user we tried to delete should still be able to login
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
});

test("list users unauthorized", async () => {
  const listUsersRes = await request(app).get("/api/user");
  expect(listUsersRes.status).toBe(401);
});

test("list users", async () => {
  const [user, userToken] = await registerUser(request(app));
  const listUsersRes = await request(app)
    .get("/api/user")
    .set("Authorization", "Bearer " + userToken);
  expect(listUsersRes.status).toBe(200);
});

async function registerUser(service) {
  const testUser = {
    name: "pizza diner",
    email: `${randomName()}@test.com`,
    password: "a",
  };
  const registerRes = await service.post("/api/auth").send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}
//Return a list of users
// Handle the pagination of the list
// Handle the name filter

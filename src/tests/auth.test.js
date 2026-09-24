const request = require("supertest");
const app = require("../service");
const { DB, Role } = require("../database/database.js");
const config = require("../config.js");
const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
const testAdmin = { name: "admin", email: "admin@test.com", password: "admin" };
let testUserAuthToken;
let testAdminAuthToken;
const crustyPizza = {
  title: "Crusty",
  description: "A dry mouthed favorite",
  image: "pizza4.png",
  price: 0.0028,
};
let crustyId;

const dbHost = config.db.connection.host;
if (!["127.0.0.1", "localhost"].includes(dbHost)) {
  throw new Error(
    `Refusing to run tests against non-local database host: ${dbHost}`,
  );
  //claude recommended this and I actually think its a great idea
}

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserAuthToken = registerRes.body.token;

  testAdmin.email = Math.random().toString(36).substring(2, 12) + "@admin.com";
  await DB.addUser({ ...testAdmin, roles: [{ role: Role.Admin }] }); //add the admin to the database :D
  const adminRes = await request(app).put("/api/auth").send(testAdmin); //log in as the admin
  testAdminAuthToken = adminRes.body.token;

  const addedCrusty = await DB.addMenuItem(crustyPizza);
  crustyId = addedCrusty.id;
});

afterAll(async () => {
  await DB.removeMenuItem({ id: crustyId });
});

test("login", async () => {
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );

  const { password, ...user } = { ...testUser, roles: [{ role: "diner" }] };
  expect(password).toBe(password);
  expect(loginRes.body.user).toMatchObject(user);
});

test("get menu as a registered user", async () => {
  const menuRes = await request(app)
    .get("/api/order/menu")
    .set("Authorization", `Bearer ${testUserAuthToken}`);
  expect(menuRes.status).toBe(200);
  expect(menuRes.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...crustyPizza, id: crustyId }),
    ]),
  );
});
//happy path 200
test("add and delete a pizza as an admin", async () => {
  const newPizza = {
    title: "Test Pizza " + Math.random().toString(36).substring(2, 8),
    description:
      "An elusive pizza, that only appears in dreams. (Or a test database)",
    image: "pizza9.png",
    price: 0.000042,
  };
  const addSpy = jest.spyOn(DB, "addMenuItem");

  // Add the pizza
  const pizzaRes = await request(app)
    .put("/api/order/menu")
    .set("Authorization", `Bearer ${testAdminAuthToken}`)
    .send(newPizza);

  expect(pizzaRes.status).toBe(200);
  expect(addSpy).toHaveBeenCalledWith(newPizza);

  // The route returns the whole menu, so find our pizza by its unique title
  const addedPizza = pizzaRes.body.find((p) => p.title === newPizza.title);
  expect(addedPizza).toMatchObject({ ...newPizza, id: expect.any(Number) });

  // Delete the pizza
  const deleteRes = await request(app)
    .delete("/api/order/menu")
    .set("Authorization", `Bearer ${testAdminAuthToken}`)
    .send({ id: addedPizza.id });

  //basically expect the pizza we added to NOT be in the menu.
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: addedPizza.id })]),
  );
});
//bad path 403

// //fix this
// test("order a pizza with a registered user", async () => {
//   const pizzaRes = await request(app)
//     .get("/api/order/pizza")
//     .set("Authorization", `Bearer ${testUserAuthToken}`);
//   expect(pizzaRes.status).toBe(200);
//   expect(pizzaRes.body).toEqual();
// });

// async function createAdminUser() {
//   let user = { password: "toomanysecrets", roles: [{ role: Role.Admin }] };
//   user.name = randomName();
//   user.email = user.name + "@admin.com";

//   await DB.addUser(user);
//   user.password = "toomanysecrets";

//   return user;
// }

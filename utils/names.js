const FIRST_NAMES = [
  'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
  'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Christopher', 'Karen', 'Daniel', 'Lisa', 'Matthew', 'Nancy',
  'Anthony', 'Betty', 'Mark', 'Margaret', 'Steven', 'Sandra', 'Andrew', 'Ashley',
  'Paul', 'Emily', 'Joshua', 'Donna', 'Kenneth', 'Michelle', 'Kevin', 'Dorothy',
  'Brian', 'Carol', 'George', 'Amanda', 'Timothy', 'Melissa', 'Ronald', 'Deborah',
  'Edward', 'Stephanie', 'Jason', 'Rebecca', 'Jeffrey', 'Sharon', 'Ryan', 'Laura',
  'Jacob', 'Cynthia', 'Gary', 'Kathleen', 'Nicholas', 'Amy', 'Eric', 'Angela',
  'Jonathan', 'Anna', 'Stephen', 'Shirley', 'Larry', 'Ruth', 'Justin', 'Brenda',
  'Scott', 'Pamela', 'Brandon', 'Nicole', 'Benjamin', 'Katherine', 'Samuel', 'Samantha',
  'Gregory', 'Christine', 'Alexander', 'Catherine', 'Frank', 'Virginia', 'Patrick', 'Debra',
  'Raymond', 'Rachel', 'Jack', 'Janet', 'Dennis', 'Emma', 'Jerry', 'Carolyn',
  'Tyler', 'Maria', 'Aaron', 'Heather', 'Jose', 'Helen', 'Adam', 'Catherine',
  'Nathan', 'Diane', 'Henry', 'Julie', 'Douglas', 'Victoria', 'Zachary', 'Joyce',
  'Peter', 'Lauren', 'Kyle', 'Kelly', 'Walter', 'Christina', 'Harold', 'Ruth',
  'Jeremy', 'Joan', 'Ethan', 'Virginia', 'Carl', 'Judith', 'Keith', 'Evelyn',
  'Roger', 'Megan', 'Gerald', 'Andrea', 'Christian', 'Cheryl', 'Terry', 'Hannah',
  'Sean', 'Jacqueline', 'Arthur', 'Martha', 'Austin', 'Gloria', 'Noah', 'Teresa',
  'Lawrence', 'Ann', 'Oliver', 'Sara', 'Lucas', 'Janice', 'Mason', 'Julia'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
  'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell',
  'Carter', 'Roberts', 'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker',
  'Cruz', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris', 'Morales', 'Murphy',
  'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper', 'Peterson', 'Bailey',
  'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson',
  'Watson', 'Brooks', 'Chavez', 'Wood', 'James', 'Bennett', 'Gray', 'Mendoza',
  'Ruiz', 'Hughes', 'Price', 'Alvarez', 'Castillo', 'Sanders', 'Patel', 'Myers',
  'Long', 'Ross', 'Foster', 'Jimenez', 'Porter', 'Hunter', 'Webb', 'Gordon',
  'Castro', 'Ortiz', 'Guzman', 'Gomez', 'Mendoza', 'Munoz', 'Aguilar', 'Rios',
  'Delgado', 'Vargas', 'Rojas', 'Santos', 'Ortega', 'Guerrero', 'Soto', 'Medina',
  'Vega', 'Guzman', 'Pena', 'Flores', 'Mendez', 'Vasquez', 'Caballero', 'Nunez'
];

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function randomFirstName() {
  return FIRST_NAMES[rand(0, FIRST_NAMES.length)];
}

function randomLastName() {
  return LAST_NAMES[rand(0, LAST_NAMES.length)];
}

module.exports = {
  FIRST_NAMES,
  LAST_NAMES,
  randomFirstName,
  randomLastName,
};

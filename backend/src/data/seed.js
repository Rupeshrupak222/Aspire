// Seed data: 53 sample questions (15 aptitude, 30 technical, 8 coding).
// Marks questions with is_sample = 1.

const APTITUDE_QUESTIONS = [
  {
    category: 'aptitude',
    question_text: 'If A:B = 2:3 and B:C = 4:5, what is the ratio A:C?',
    options: ['8:15', '2:5', '6:15', '4:15'],
    correct_index: 0
  },
  {
    category: 'aptitude',
    question_text: 'A can complete a project in 12 days and B in 24 days. Working together, how many days will they take?',
    options: ['6 days', '8 days', '10 days', '16 days'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'A train 150 meters long traveling at 72 km/h crosses a signal post in how many seconds?',
    options: ['5 seconds', '7.5 seconds', '10 seconds', '12 seconds'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'If the price of an article increases by 25%, by what percentage must consumption be reduced to keep expenditure constant?',
    options: ['20%', '25%', '15%', '16.67%'],
    correct_index: 0
  },
  {
    category: 'aptitude',
    question_text: 'An item bought for $80 is sold for $100. What is the profit percentage?',
    options: ['20%', '25%', '30%', '15%'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'Find the next number in the sequence: 2, 6, 12, 20, 30, ?',
    options: ['40', '42', '44', '46'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'Pointing to a photograph, a man said: "I have no brother or sister, but that man\'s father is my father\'s son." Whose photograph was it?',
    options: ['His father\'s', 'His nephew\'s', 'His son\'s', 'His own'],
    correct_index: 2
  },
  {
    category: 'aptitude',
    question_text: 'In a code language, COMPUTER is written as RFUVQNPC. How is MEDICINE written in that code?',
    options: ['MFEDJJOE', 'EOJDEJFM', 'EOJDJEFM', 'MFEJDJOE'],
    correct_index: 2
  },
  {
    category: 'aptitude',
    question_text: 'What is the angle between the hour hand and the minute hand of a clock at 3:30?',
    options: ['70°', '75°', '80°', '85°'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'Two unbiased dice are thrown together. What is the probability of obtaining a total sum of 7?',
    options: ['1/6', '7/36', '1/12', '5/36'],
    correct_index: 0
  },
  {
    category: 'aptitude',
    question_text: 'The average of 5 consecutive odd numbers is 27. What is the largest of these numbers?',
    options: ['29', '31', '33', '35'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'In how many different ways can the letters of the word "LEADER" be arranged?',
    options: ['720', '360', '120', '48'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'At what rate of simple interest per annum will a sum of money double itself in 8 years?',
    options: ['10%', '12%', '12.5%', '15%'],
    correct_index: 2
  },
  {
    category: 'aptitude',
    question_text: 'Statements: All roses are flowers. Some flowers fade quickly. Which conclusion logically follows?',
    options: ['All flowers are roses', 'Some flowers are roses', 'All roses fade quickly', 'No roses fade quickly'],
    correct_index: 1
  },
  {
    category: 'aptitude',
    question_text: 'A pipe can fill a cistern in 6 hours, while an outlet pipe can empty it in 8 hours. If both pipes are opened, in how many hours will the cistern fill?',
    options: ['14 hours', '20 hours', '24 hours', '48 hours'],
    correct_index: 2
  }
];

const TECHNICAL_QUESTIONS = [
  {
    category: 'technical',
    question_text: 'What is the search time complexity in a balanced Binary Search Tree (such as an AVL tree) with n elements?',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In JavaScript, what does `typeof null` evaluate to?',
    options: ['"null"', '"undefined"', '"object"', '"boolean"'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'Which data structure follows the First-In, First-Out (FIFO) principle?',
    options: ['Stack', 'Queue', 'Heap', 'Tree'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In SQL, which clause filters records grouped by the GROUP BY clause?',
    options: ['WHERE', 'ORDER BY', 'HAVING', 'FILTER'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the result of `[] + []` in JavaScript?',
    options: ['"" (empty string)', '[]', 'undefined', 'NaN'],
    correct_index: 0
  },
  {
    category: 'technical',
    question_text: 'In Python, what is the boolean value of an empty list `bool([])`?',
    options: ['True', 'False', 'None', 'Error'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'Which HTTP response status code represents "Unauthorized"?',
    options: ['400', '401', '403', '404'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In relational database theory, what does Third Normal Form (3NF) eliminate?',
    options: ['Multivalued attributes', 'Partial functional dependencies', 'Transitive functional dependencies', 'Duplicate rows'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the worst-case time complexity of QuickSort?',
    options: ['O(n)', 'O(n log n)', 'O(n^2)', 'O(log n)'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'Which protocol operates at the Transport Layer of the OSI reference model?',
    options: ['IP', 'TCP', 'HTTP', 'Ethernet'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In JavaScript, what is the result of `[1, 2, 3].map(x => x * 2)`?',
    options: ['[2, 4, 6]', '[1, 2, 3]', '6', '[1, 4, 9]'],
    correct_index: 0
  },
  {
    category: 'technical',
    question_text: 'What do the letters in ACID database transactions stand for?',
    options: ['Action, Consistency, Integrity, Durability', 'Atomicity, Consistency, Isolation, Durability', 'Atomicity, Concurrency, Isolation, Distribution', 'Availability, Consistency, Integrity, Durability'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In Python, which statement ensures a resource like a file is automatically released when execution leaves the block?',
    options: ['using', 'try-catch', 'with', 'defer'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'In JavaScript, what is the value of expression `2 + "2"`?',
    options: ['4', '"22"', 'NaN', 'TypeError'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'Which Git command stages modified files to the index?',
    options: ['git push', 'git commit', 'git add', 'git checkout'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'Which algorithm design paradigm does Dijkstra’s shortest path algorithm employ?',
    options: ['Dynamic Programming', 'Divide and Conquer', 'Greedy', 'Backtracking'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'In JavaScript, what does `0.1 + 0.2 === 0.3` evaluate to?',
    options: ['true', 'false', 'undefined', 'NaN'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'What is a fundamental difference between a Process and a Thread?',
    options: ['Processes share memory; threads have separate address spaces', 'Threads of the same process share the same address space', 'Threads cannot run concurrently', 'Processes cannot communicate with each other'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'Which of the following data types in Python is immutable?',
    options: ['list', 'dict', 'set', 'tuple'],
    correct_index: 3
  },
  {
    category: 'technical',
    question_text: 'What is the time complexity of prepending (inserting at index 0) an element to a standard dynamic array of length n?',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n^2)'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the purpose of the CSS `z-index` property?',
    options: ['Sets zoom scale', 'Controls vertical alignment', 'Determines stack order of positioned elements', 'Specifies 3D rotation angle'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'In SQL, what does an `INNER JOIN` query return?',
    options: ['All rows from left table', 'All rows from both tables', 'Only records that have matching values in both tables', 'Rows without matches in either table'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What does the acronym CORS stand for in web browsers?',
    options: ['Cross-Origin Request Standard', 'Cross-Origin Resource Sharing', 'Client-Oriented Remote Service', 'Common Object Request System'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'In Python, what is the result of expression `"hello"[::-1]`?',
    options: ['"hello"', '"olleh"', '"h"', 'IndexError'],
    correct_index: 1
  },
  {
    category: 'technical',
    question_text: 'Which design pattern restricts the instantiation of a class to one single object?',
    options: ['Factory', 'Observer', 'Singleton', 'Adapter'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the average case lookup time complexity in a Hash Table?',
    options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
    correct_index: 0
  },
  {
    category: 'technical',
    question_text: 'In JavaScript (ES6+), which declaration creates a block-scoped identifier that cannot be reassigned?',
    options: ['var', 'let', 'const', 'global'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the main purpose of creating an index on database table columns?',
    options: ['Encrypt column values', 'Enforce foreign key constraints', 'Accelerate data query and retrieval performance', 'Reduce storage disk usage'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'What is the standard TCP port for secure HTTPS web traffic?',
    options: ['80', '8080', '443', '22'],
    correct_index: 2
  },
  {
    category: 'technical',
    question_text: 'In Python, what does the `is` operator check?',
    options: ['Value equality', 'Memory identity of objects', 'Data type equivalence', 'Subset membership'],
    correct_index: 1
  }
];

const CODING_QUESTIONS = [
  {
    category: 'coding',
    question_text: 'Write a Python program that reads two space-separated integers from standard input and prints their sum.',
    code_starter: `import sys\n\ndef main():\n    nums = list(map(int, sys.stdin.read().split()))\n    if nums:\n        print(nums[0] + nums[1])\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: '3 5\n', expected: '8\n' },
      { input: '-10 25\n', expected: '15\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads a string from standard input and prints the string reversed.',
    code_starter: `import sys\n\ndef main():\n    text = sys.stdin.read().strip()\n    print(text[::-1])\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: 'hello\n', expected: 'olleh\n' },
      { input: 'racecar\n', expected: 'racecar\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads an integer from standard input and prints "Even" if it is even, or "Odd" if it is odd.',
    code_starter: `import sys\n\ndef main():\n    n = int(sys.stdin.read().strip())\n    print("Even" if n % 2 == 0 else "Odd")\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: '4\n', expected: 'Even\n' },
      { input: '7\n', expected: 'Odd\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads an integer N (>= 0) and prints its factorial (N!).',
    code_starter: `import sys\nimport math\n\ndef main():\n    n = int(sys.stdin.read().strip())\n    print(math.factorial(n))\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: '5\n', expected: '120\n' },
      { input: '0\n', expected: '1\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads a string and prints the count of vowels (a, e, i, o, u case-insensitive).',
    code_starter: `import sys\n\ndef main():\n    s = sys.stdin.read().lower()\n    vowels = set('aeiou')\n    print(sum(1 for ch in s if ch in vowels))\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: 'Hello World\n', expected: '3\n' },
      { input: 'rhythm\n', expected: '0\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads a sequence of space-separated integers on a single line and prints the maximum value.',
    code_starter: `import sys\n\ndef main():\n    nums = list(map(int, sys.stdin.read().split()))\n    if nums:\n        print(max(nums))\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: '1 5 3 9 2\n', expected: '9\n' },
      { input: '-10 -5 -20\n', expected: '-5\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads a word and prints "true" if it is a palindrome, or "false" otherwise.',
    code_starter: `import sys\n\ndef main():\n    w = sys.stdin.read().strip()\n    print("true" if w == w[::-1] else "false")\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: 'madam\n', expected: 'true\n' },
      { input: 'aspire\n', expected: 'false\n' }
    ]
  },
  {
    category: 'coding',
    question_text: 'Write a Python program that reads an integer N (>= 0) and prints the N-th Fibonacci number (where F(0)=0, F(1)=1, F(2)=1...).',
    code_starter: `import sys\n\ndef fib(n):\n    if n <= 0: return 0\n    if n == 1: return 1\n    a, b = 0, 1\n    for _ in range(2, n + 1):\n        a, b = b, a + b\n    return b\n\ndef main():\n    n = int(sys.stdin.read().strip())\n    print(fib(n))\n\nif __name__ == '__main__':\n    main()\n`,
    language_id: 71,
    test_cases: [
      { input: '6\n', expected: '8\n' },
      { input: '0\n', expected: '0\n' }
    ]
  }
];

const crypto = require('crypto');
const bcrypt = require('bcrypt');

function seedAuthIfEmpty(db) {
  // 1. Ensure default organization exists
  let orgRow = db.prepare('SELECT id FROM organizations ORDER BY id ASC LIMIT 1').get();
  if (!orgRow) {
    const res = db.prepare(`
      INSERT INTO organizations (name, slug, status)
      VALUES ('Adyapan Academy', 'adyapan', 'ACTIVE')
    `).run();
    orgRow = { id: res.lastInsertRowid };
  }

  // 2. Ensure initial Super Admin exists
  const adminRow = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'SUPER_ADMIN'").get();
  if (!adminRow || adminRow.c === 0) {
    const email = process.env.INITIAL_ADMIN_EMAIL
      ? process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase()
      : (process.env.NODE_ENV !== 'production' ? 'admin@adyapan.internal' : null);

    const password = process.env.INITIAL_ADMIN_PASSWORD
      ? process.env.INITIAL_ADMIN_PASSWORD
      : (process.env.NODE_ENV !== 'production' ? crypto.randomBytes(12).toString('hex') : null);

    const name = process.env.INITIAL_ADMIN_NAME || 'Super Administrator';

    if (email && password) {
      const isTest = process.env.NODE_ENV === 'test';
      const rounds = isTest ? 6 : 10;
      const hash = bcrypt.hashSync(password, rounds);

      db.prepare(`
        INSERT INTO users (email, password_hash, name, role, organization_id, status)
        VALUES (?, ?, ?, 'SUPER_ADMIN', NULL, 'ACTIVE')
      `).run(email, hash, name);

      if (process.env.NODE_ENV !== 'production' && !process.env.INITIAL_ADMIN_PASSWORD) {
        console.log('[aspire-auth] Initial Super Admin created for local dev:');
        console.log(`[aspire-auth]   Email:    ${email}`);
        console.log(`[aspire-auth]   Password: ${password}`);
        console.log('[aspire-auth]   Set INITIAL_ADMIN_EMAIL & INITIAL_ADMIN_PASSWORD in .env for production.');
      }
    } else if (process.env.NODE_ENV === 'production') {
      console.warn('[aspire-auth] WARNING: No Super Admin exists in production! Run `npm run bootstrap:admin` to initialize.');
    }
  }
}

function seedIfEmpty(db) {
  seedAuthIfEmpty(db);

  const row = db.prepare('SELECT COUNT(*) as c FROM questions').get();
  if (row && row.c > 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO questions
      (type, category, question_text, options_json, correct_index, code_starter, language_id, test_cases_json, marks, is_sample)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const runAll = db.transaction(() => {
    // 15 Aptitude questions
    for (const q of APTITUDE_QUESTIONS) {
      insertStmt.run(
        'mcq',
        q.category,
        q.question_text,
        JSON.stringify(q.options),
        q.correct_index,
        null,
        null,
        null,
        1
      );
    }
    // 30 Technical questions
    for (const q of TECHNICAL_QUESTIONS) {
      insertStmt.run(
        'mcq',
        q.category,
        q.question_text,
        JSON.stringify(q.options),
        q.correct_index,
        null,
        null,
        null,
        1
      );
    }
    // 8 Coding questions
    for (const q of CODING_QUESTIONS) {
      insertStmt.run(
        'code',
        q.category,
        q.question_text,
        null,
        null,
        q.code_starter,
        q.language_id || 71,
        JSON.stringify(q.test_cases),
        1
      );
    }
  });

  runAll();
}

module.exports = { seedIfEmpty, seedAuthIfEmpty };


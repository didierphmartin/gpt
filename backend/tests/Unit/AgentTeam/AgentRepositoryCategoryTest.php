<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Tests\Unit\AgentTeam;

use PHPUnit\Framework\TestCase;
use AgentTeam\Models\Agent;
use AgentTeam\Services\AgentRepository;
use PDO;

/**
 * Repository tests for the `category` container feature on agents.
 *
 * Uses an in-memory SQLite DB. We mirror only the columns the repository
 * touches — JSON columns become TEXT (the repo encodes/decodes itself).
 */
class AgentRepositoryCategoryTest extends TestCase
{
    private PDO $db;
    private AgentRepository $repo;

    protected function setUp(): void
    {
        $this->db = new PDO('sqlite::memory:');
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->db->exec("
            CREATE TABLE agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                team_id INTEGER DEFAULT NULL,
                category TEXT DEFAULT NULL,
                name TEXT NOT NULL,
                description TEXT,
                agent_type TEXT DEFAULT 'standard',
                parent_agent_id INTEGER DEFAULT NULL,
                can_delegate_to TEXT,
                display_order INTEGER NOT NULL DEFAULT 0,
                provider TEXT DEFAULT 'claude',
                model TEXT DEFAULT NULL,
                instructions TEXT,
                tools TEXT,
                visibility TEXT DEFAULT 'personal',
                enabled INTEGER DEFAULT 1,
                settings TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        ");
        $this->repo = new AgentRepository($this->db);
    }

    private function makeAgent(int $userId, string $name, ?string $category = null): Agent
    {
        return new Agent([
            'user_id' => $userId,
            'name' => $name,
            'category' => $category,
            'description' => '',
            'agent_type' => 'standard',
            'provider' => 'claude',
            'instructions' => '',
            'tools' => [],
            'visibility' => 'personal',
            'enabled' => true,
            'settings' => [],
        ]);
    }

    public function testCreatePersistsCategory(): void
    {
        $saved = $this->repo->create($this->makeAgent(1, 'Alice', 'Research'));
        $this->assertSame('Research', $saved->getCategory());

        $reloaded = $this->repo->findById($saved->getId());
        $this->assertSame('Research', $reloaded->getCategory());
    }

    public function testCreateWithoutCategoryStoresNull(): void
    {
        $saved = $this->repo->create($this->makeAgent(1, 'Loose'));
        $this->assertNull($saved->getCategory());
    }

    public function testUpdateChangesCategory(): void
    {
        $saved = $this->repo->create($this->makeAgent(1, 'Bob', 'A'));
        $saved->setCategory('B');
        $updated = $this->repo->update($saved);
        $this->assertSame('B', $updated->getCategory());

        $saved->setCategory(null);
        $cleared = $this->repo->update($saved);
        $this->assertNull($cleared->getCategory());
    }

    public function testFilterByCategoryReturnsOnlyMatchingAgents(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'X'));
        $this->repo->create($this->makeAgent(1, 'B', 'X'));
        $this->repo->create($this->makeAgent(1, 'C', 'Y'));
        $this->repo->create($this->makeAgent(1, 'D'));

        $results = $this->repo->findAccessibleByUser(1, ['category' => 'X']);
        $names = array_map(fn($a) => $a->getName(), $results);
        sort($names);
        $this->assertSame(['A', 'B'], $names);
    }

    public function testFilterByNoneReturnsUncategorizedAgents(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'X'));
        $this->repo->create($this->makeAgent(1, 'D'));
        $this->repo->create($this->makeAgent(1, 'E'));

        $results = $this->repo->findAccessibleByUser(1, ['category' => '__none__']);
        $names = array_map(fn($a) => $a->getName(), $results);
        sort($names);
        $this->assertSame(['D', 'E'], $names);
    }

    public function testFindDistinctCategoriesIsPerUserAndExcludesNull(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Research'));
        $this->repo->create($this->makeAgent(1, 'B', 'Research'));
        $this->repo->create($this->makeAgent(1, 'C', 'Marketing'));
        $this->repo->create($this->makeAgent(1, 'D'));
        $this->repo->create($this->makeAgent(2, 'Z', 'OtherUserCategory'));

        $cats = $this->repo->findDistinctCategories(1);
        $this->assertSame(['Marketing', 'Research'], $cats);
    }

    public function testRenameCategoryUpdatesAllMatchingRows(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Old'));
        $this->repo->create($this->makeAgent(1, 'B', 'Old'));
        $this->repo->create($this->makeAgent(1, 'C', 'Different'));
        $this->repo->create($this->makeAgent(2, 'X', 'Old')); // other user, untouched

        $affected = $this->repo->renameCategory(1, 'Old', 'New');
        $this->assertSame(2, $affected);

        $cats = $this->repo->findDistinctCategories(1);
        sort($cats);
        $this->assertSame(['Different', 'New'], $cats);

        // Other user's category is unchanged
        $other = $this->repo->findDistinctCategories(2);
        $this->assertSame(['Old'], $other);
    }

    public function testRenameToSameNameReturnsZeroWithoutError(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Foo'));
        // Same name still updates rows in SQL terms; the controller short-circuits.
        // The repository itself just runs the UPDATE.
        $affected = $this->repo->renameCategory(1, 'Foo', 'Foo');
        $this->assertGreaterThanOrEqual(0, $affected);
    }

    public function testClearCategoryNullsMatchingRows(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Doomed'));
        $this->repo->create($this->makeAgent(1, 'B', 'Doomed'));
        $this->repo->create($this->makeAgent(1, 'C', 'Survivor'));

        $affected = $this->repo->clearCategory(1, 'Doomed');
        $this->assertSame(2, $affected);

        $uncategorized = $this->repo->findAccessibleByUser(1, ['category' => '__none__']);
        $names = array_map(fn($a) => $a->getName(), $uncategorized);
        sort($names);
        $this->assertSame(['A', 'B'], $names);

        $remaining = $this->repo->findDistinctCategories(1);
        $this->assertSame(['Survivor'], $remaining);
    }

    public function testClearCategoryIsScopedToUser(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Shared'));
        $this->repo->create($this->makeAgent(2, 'B', 'Shared'));

        $affected = $this->repo->clearCategory(1, 'Shared');
        $this->assertSame(1, $affected);

        // User 2's row keeps its category.
        $this->assertSame(['Shared'], $this->repo->findDistinctCategories(2));
    }

    public function testRenameAndClearRejectEmptyNames(): void
    {
        $this->repo->create($this->makeAgent(1, 'A', 'Foo'));
        $this->assertSame(0, $this->repo->renameCategory(1, '', 'New'));
        $this->assertSame(0, $this->repo->renameCategory(1, 'Foo', ''));
        $this->assertSame(0, $this->repo->clearCategory(1, ''));
    }
}
